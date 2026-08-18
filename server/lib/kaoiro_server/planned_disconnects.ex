defmodule KaoiroServer.PlannedDisconnects do
  @moduledoc """
  In-memory intent tracker for server-authorized wrapper cycles.

  A lifecycle command registers one opaque transition id before it reaches
  the runner.  The incumbent wrapper's owner-checked disconnect moves that
  intent from `:announced` to `:disconnected` and snapshots the open
  conversation peers without mutating `ConversationStates`' ordinary
  unreachable-notification marks.  Only a later join carrying the exact same
  transition id can consume the intent successfully.

  The store is deliberately separate from `SessionResets`: reset success and
  peer reachability are different facts, while restart and switch-session do
  not have a reset lock at all.  Like the other in-memory conversation and
  reset trackers, all intents disappear on a server restart.
  """

  use GenServer

  require Logger

  alias KaoiroServer.ConversationStates

  @default_timeout_ms 60_000
  @max_unreachable_notices 50
  @kinds [:reset, :switch_session, :restart]

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)

    GenServer.start_link(
      __MODULE__,
      %{
        timeout_ms: Keyword.get(opts, :timeout_ms, @default_timeout_ms),
        target_provider:
          Keyword.get(opts, :target_provider, &ConversationStates.unreachable_targets/2),
        on_timeout: Keyword.get(opts, :on_timeout, &default_on_timeout/2)
      },
      name: name
    )
  end

  defp default_on_timeout(_agent_id, _transition_id), do: :ok

  @doc """
  Registers one planned lifecycle transition for `agent_id`.

  At most one intent may be active per agent. A competing lifecycle command
  receives `{:error, :agent_busy}` and cannot silently replace the existing
  transition.
  """
  def begin(agent_id, transition_id, kind, server \\ __MODULE__)
      when is_binary(agent_id) and is_binary(transition_id) and transition_id != "" and
             kind in @kinds do
    GenServer.call(server, {:begin, agent_id, transition_id, kind})
  end

  @doc """
  Adopts the incumbent wrapper's owner-checked disconnect.

  Returns `{:planned, intent}` only for the first disconnect of an announced
  intent. `intent.targets` is the bounded read-only conversation snapshot to
  receive `reconnecting` and, on matching success, `reconnected`.
  """
  def disconnect(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    GenServer.call(server, {:disconnect, agent_id})
  end

  @doc """
  Completes a disconnected intent only when `transition_id` matches exactly.

  A stale or malformed join cannot consume the state. The returned intent is
  the same snapshot captured at disconnect time.
  """
  def confirm_connection(agent_id, transition_id, server \\ __MODULE__)
      when is_binary(agent_id) do
    GenServer.call(server, {:confirm_connection, agent_id, transition_id})
  end

  @doc """
  Fails the matching intent by transition-id CAS.

  `:spawn_failed` is special for session reset: the runner emits it only after
  successfully launching the rollback wrapper, so connectivity remains
  pending until that wrapper's matching join (or this store's own timeout).
  Other reasons close the intent immediately; the caller decides whether the
  agent is still authoritatively disconnected and needs a terminal notice.
  """
  def fail(agent_id, transition_id, reason, server \\ __MODULE__)
      when is_binary(agent_id) do
    GenServer.call(server, {:fail, agent_id, transition_id, reason})
  end

  @doc "Returns true while any planned intent is active for the agent."
  def active?(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    GenServer.call(server, {:active?, agent_id})
  end

  @doc "Returns the public intent state for diagnostics/tests, or nil."
  def get(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    GenServer.call(server, {:get, agent_id})
  end

  @doc "Purges an intent without producing a peer notification."
  def delete(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    GenServer.call(server, {:delete, agent_id})
  end

  @impl true
  def init(opts), do: {:ok, Map.put(opts, :pending, %{})}

  @impl true
  def handle_call({:begin, agent_id, transition_id, kind}, _from, state) do
    if Map.has_key?(state.pending, agent_id) do
      {:reply, {:error, :agent_busy}, state}
    else
      timer_ref =
        Process.send_after(self(), {:timeout, agent_id, transition_id}, state.timeout_ms)

      intent = %{
        agent_id: agent_id,
        transition_id: transition_id,
        kind: kind,
        phase: :announced,
        targets: [],
        unclaimed: 0,
        timer_ref: timer_ref
      }

      {:reply, :ok, put_intent(state, agent_id, intent)}
    end
  end

  def handle_call({:disconnect, agent_id}, _from, state) do
    case Map.get(state.pending, agent_id) do
      %{phase: :announced} = intent ->
        {targets, unclaimed} = safe_targets(state.target_provider, agent_id)
        disconnected = %{intent | phase: :disconnected, targets: targets, unclaimed: unclaimed}

        {:reply, {:planned, public_intent(disconnected)},
         put_intent(state, agent_id, disconnected)}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:confirm_connection, agent_id, transition_id}, _from, state) do
    case Map.get(state.pending, agent_id) do
      %{phase: :disconnected, transition_id: ^transition_id} = intent
      when is_binary(transition_id) and transition_id != "" ->
        {:reply, {:reconnected, public_intent(intent)}, discard_intent(state, agent_id)}

      nil ->
        {:reply, :noop, state}

      _intent ->
        {:reply, :mismatch, state}
    end
  end

  def handle_call({:fail, agent_id, transition_id, reason}, _from, state) do
    case Map.get(state.pending, agent_id) do
      %{transition_id: ^transition_id, kind: :reset} = intent when reason == :spawn_failed ->
        {:reply, {:deferred, public_intent(intent)}, state}

      %{transition_id: ^transition_id} = intent ->
        {:reply, {:failed, public_intent(intent)}, discard_intent(state, agent_id)}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:active?, agent_id}, _from, state) do
    {:reply, Map.has_key?(state.pending, agent_id), state}
  end

  def handle_call({:get, agent_id}, _from, state) do
    intent = state.pending |> Map.get(agent_id) |> maybe_public_intent()
    {:reply, intent, state}
  end

  def handle_call({:delete, agent_id}, _from, state) do
    {:reply, :ok, discard_intent(state, agent_id)}
  end

  @impl true
  def handle_info({:timeout, agent_id, transition_id}, state) do
    case Map.get(state.pending, agent_id) do
      %{transition_id: ^transition_id} ->
        # Run the terminal callback while this GenServer still serializes the
        # transition: a same-token join is either processed before this
        # timeout and cancels it, or after it and is stale. There is no window
        # in which both success and timeout can consume the intent.
        safe_timeout(state.on_timeout, agent_id, transition_id)
        {:noreply, %{state | pending: Map.delete(state.pending, agent_id)}}

      _ ->
        {:noreply, state}
    end
  end

  defp safe_targets(provider, agent_id) do
    case provider.(agent_id, @max_unreachable_notices) do
      {targets, unclaimed} when is_list(targets) and is_integer(unclaimed) and unclaimed >= 0 ->
        {targets, unclaimed}

      other ->
        Logger.warning(
          "planned disconnect target provider returned invalid value for #{agent_id}: " <>
            inspect(other)
        )

        {[], 0}
    end
  rescue
    error ->
      Logger.warning(
        "planned disconnect target provider failed for #{agent_id}: " <>
          Exception.message(error)
      )

      {[], 0}
  catch
    kind, reason ->
      Logger.warning(
        "planned disconnect target provider #{kind} for #{agent_id}: #{inspect(reason)}"
      )

      {[], 0}
  end

  defp safe_timeout(callback, agent_id, transition_id) do
    callback.(agent_id, transition_id)
  rescue
    error ->
      Logger.warning(
        "planned disconnect timeout callback failed for #{agent_id}: " <>
          Exception.message(error)
      )
  catch
    kind, reason ->
      Logger.warning(
        "planned disconnect timeout callback #{kind} for #{agent_id}: #{inspect(reason)}"
      )
  end

  defp put_intent(state, agent_id, intent),
    do: %{state | pending: Map.put(state.pending, agent_id, intent)}

  defp discard_intent(state, agent_id) do
    case Map.pop(state.pending, agent_id) do
      {nil, _pending} ->
        state

      {%{timer_ref: timer_ref}, pending} ->
        _ = Process.cancel_timer(timer_ref)
        %{state | pending: pending}
    end
  end

  defp maybe_public_intent(nil), do: nil
  defp maybe_public_intent(intent), do: public_intent(intent)

  defp public_intent(intent), do: Map.delete(intent, :timer_ref)
end
