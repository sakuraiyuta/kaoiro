defmodule KaoiroServer.PlannedDisconnects do
  @moduledoc """
  In-memory intent tracker for server-authorized wrapper cycles.

  A lifecycle command registers one opaque transition id before it reaches
  the runner.  The intent is the source of truth for every peer that either
  receives a synthetic `reconnecting` notice or gets a `peer_reconnecting`
  preflight bounce.  The bounded target set counts one synthetic envelope as
  one `{conversation_id, peer_id}` pair; only a sender admitted to that set is
  promised the later close notice. The incumbent wrapper's owner-checked
  disconnect moves the intent from `:announced` to `:disconnected` and merges
  the open conversation peers into that set without mutating `ConversationStates`'
  ordinary unreachable-notification marks.  Every consuming transition
  returns the same target union so the web boundary can close it with either
  `reconnected` or terminal `disconnected`.

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

  @doc "Shared cap for ordinary conversations and planned synth target pairs."
  def max_unreachable_notices, do: @max_unreachable_notices

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)

    GenServer.start_link(
      __MODULE__,
      %{
        timeout_ms: Keyword.get(opts, :timeout_ms, @default_timeout_ms),
        target_provider:
          Keyword.get(opts, :target_provider, &ConversationStates.unreachable_targets/2),
        max_targets: Keyword.get(opts, :max_targets, @max_unreachable_notices),
        on_timeout: Keyword.get(opts, :on_timeout, &default_on_timeout/3)
      },
      name: name
    )
  end

  defp default_on_timeout(_agent_id, _transition_id, _intent), do: :ok

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
  intent. `intent.notice_targets` is the bounded read-only conversation
  snapshot that has not already received a preflight bounce;
  `intent.targets` is the full bounded terminal-notice union. Any snapshot
  pair that could not fit is returned in `intent.dropped_targets` for the web
  boundary to log explicitly.
  """
  def disconnect(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    GenServer.call(server, {:disconnect, agent_id})
  end

  @doc """
  Atomically checks for an active planned window and records one bounced peer.

  The caller may return `peer_reconnecting` only after this returns
  `{:tracked, intent}`. A new target that cannot fit returns
  `{:capacity, intent}` without changing state, so the caller can reject it
  without making a close-notice promise. A concurrent close wins by making
  this return `:noop`, in which case normal delivery may continue.
  """
  def track_bounce(agent_id, conversation_id, peer_id, server \\ __MODULE__)
      when is_binary(agent_id) and is_binary(conversation_id) and is_binary(peer_id) do
    GenServer.call(server, {:track_bounce, agent_id, conversation_id, peer_id})
  end

  @doc """
  Completes an announced or disconnected intent only when `transition_id`
  matches exactly.

  A stale or malformed join cannot consume the state. The returned intent
  carries every snapshot or bounce target accumulated before the join won.
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
  Other reasons close the intent immediately; the caller uses authoritative
  reachability to choose `disconnected` or the neutral `reconnected` outcome.
  """
  def fail(agent_id, transition_id, reason, server \\ __MODULE__)
      when is_binary(agent_id) do
    GenServer.call(server, {:fail, agent_id, transition_id, reason})
  end

  @doc "Consumes any active intent, returning its target union. Used by stop/purge."
  def cancel(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    GenServer.call(server, {:cancel, agent_id})
  end

  @doc "Consumes only the exact transition. Used to roll back setup failures."
  def cancel_transition(agent_id, transition_id, server \\ __MODULE__)
      when is_binary(agent_id) and is_binary(transition_id) do
    GenServer.call(server, {:cancel_transition, agent_id, transition_id})
  end

  @doc "Returns true while any planned intent is active for the agent."
  def active?(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    GenServer.call(server, {:active?, agent_id})
  end

  @doc "Returns the public intent state for diagnostics/tests, or nil."
  def get(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    GenServer.call(server, {:get, agent_id})
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
        targets: MapSet.new(),
        dropped_targets: MapSet.new(),
        unclaimed: 0,
        timer_ref: timer_ref
      }

      {:reply, :ok, put_intent(state, agent_id, intent)}
    end
  end

  def handle_call({:disconnect, agent_id}, _from, state) do
    case Map.get(state.pending, agent_id) do
      %{phase: :announced} = intent ->
        {snapshot_targets, unclaimed} =
          safe_targets(state.target_provider, agent_id, state.max_targets)

        {targets, dropped_targets} =
          admit_targets(intent.targets, target_pairs(snapshot_targets), state.max_targets)

        notice_targets = MapSet.difference(targets, intent.targets)

        disconnected = %{
          intent
          | phase: :disconnected,
            targets: targets,
            dropped_targets: dropped_targets,
            unclaimed: unclaimed
        }

        public =
          disconnected
          |> public_intent()
          |> Map.put(:notice_targets, targets_list(notice_targets))

        {:reply, {:planned, public}, put_intent(state, agent_id, disconnected)}

      _ ->
        {:reply, :noop, state}
    end
  end

  def handle_call({:track_bounce, agent_id, conversation_id, peer_id}, _from, state) do
    case Map.get(state.pending, agent_id) do
      nil ->
        {:reply, :noop, state}

      intent ->
        target = {conversation_id, peer_id}

        cond do
          MapSet.member?(intent.targets, target) ->
            {:reply, {:tracked, public_intent(intent)}, state}

          MapSet.size(intent.targets) < state.max_targets ->
            tracked = %{intent | targets: MapSet.put(intent.targets, target)}
            {:reply, {:tracked, public_intent(tracked)}, put_intent(state, agent_id, tracked)}

          true ->
            {:reply, {:capacity, public_intent(intent)}, state}
        end
    end
  end

  def handle_call({:confirm_connection, agent_id, transition_id}, _from, state) do
    case Map.get(state.pending, agent_id) do
      %{phase: phase, transition_id: ^transition_id} = intent
      when phase in [:announced, :disconnected] and
             is_binary(transition_id) and transition_id != "" ->
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

  def handle_call({:cancel, agent_id}, _from, state) do
    case Map.get(state.pending, agent_id) do
      nil ->
        {:reply, :noop, state}

      intent ->
        {:reply, {:cancelled, public_intent(intent)}, discard_intent(state, agent_id)}
    end
  end

  def handle_call({:cancel_transition, agent_id, transition_id}, _from, state) do
    case Map.get(state.pending, agent_id) do
      %{transition_id: ^transition_id} = intent ->
        {:reply, {:cancelled, public_intent(intent)}, discard_intent(state, agent_id)}

      _ ->
        {:reply, :noop, state}
    end
  end

  @impl true
  def handle_info({:timeout, agent_id, transition_id}, state) do
    case Map.get(state.pending, agent_id) do
      %{transition_id: ^transition_id} = intent ->
        # Run the terminal callback while this GenServer still serializes the
        # transition: a same-token join is either processed before this
        # timeout and cancels it, or after it and is stale. There is no window
        # in which both success and timeout can consume the intent.
        safe_timeout(state.on_timeout, agent_id, transition_id, public_intent(intent))
        {:noreply, %{state | pending: Map.delete(state.pending, agent_id)}}

      _ ->
        {:noreply, state}
    end
  end

  defp safe_targets(provider, agent_id, limit) do
    case provider.(agent_id, limit) do
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

  defp safe_timeout(callback, agent_id, transition_id, intent) do
    callback.(agent_id, transition_id, intent)
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

  defp public_intent(intent) do
    intent
    |> Map.delete(:timer_ref)
    |> Map.update!(:targets, &targets_list/1)
    |> Map.update!(:dropped_targets, &targets_list/1)
  end

  defp target_pairs(targets) do
    for {conversation_id, peers} <- targets,
        peer <- peers,
        do: {conversation_id, peer}
  end

  defp admit_targets(current, candidates, limit) do
    Enum.reduce(candidates, {current, MapSet.new()}, fn target, {accepted, dropped} ->
      cond do
        MapSet.member?(accepted, target) -> {accepted, dropped}
        MapSet.size(accepted) < limit -> {MapSet.put(accepted, target), dropped}
        true -> {accepted, MapSet.put(dropped, target)}
      end
    end)
  end

  defp targets_list(targets) do
    targets
    |> Enum.reduce(%{}, fn {conversation_id, peer}, acc ->
      Map.update(acc, conversation_id, [peer], &[peer | &1])
    end)
    |> Enum.map(fn {conversation_id, peers} ->
      {conversation_id, peers |> Enum.uniq() |> Enum.sort()}
    end)
    |> Enum.sort_by(&elem(&1, 0))
  end
end
