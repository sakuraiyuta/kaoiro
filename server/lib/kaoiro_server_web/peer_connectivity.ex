defmodule KaoiroServerWeb.PeerConnectivity do
  @moduledoc """
  Translates planned-disconnect state transitions into peer-facing protocol
  notices.

  The core tracker owns only intent/token/timer data. This web boundary owns
  the synthetic envelope vocabulary and delivery side effects.
  """

  require Logger

  alias KaoiroServer.AgentStates
  alias KaoiroServer.ConversationStates
  alias KaoiroServer.PlannedDisconnects
  alias KaoiroServerWeb.SynthEnvelope

  @max_unreachable_notices 50

  @doc """
  Classifies an owner-checked wrapper disconnect and notifies conversation
  peers. Returns `:planned` when `reconnecting` was emitted, otherwise
  `:unexpected` after emitting the ordinary terminal `disconnected` notice.
  """
  def disconnect(agent_id, ts) do
    case PlannedDisconnects.disconnect(agent_id) do
      {:planned, intent} ->
        deliver_reconnecting(agent_id, intent, ts)
        :planned

      :noop ->
        deliver_disconnected(agent_id, ts)
        :unexpected
    end
  end

  @doc "Completes a matching planned transition and emits `reconnected`."
  def confirm_connection(agent_id, transition_id, ts \\ now()) do
    case PlannedDisconnects.confirm_connection(agent_id, transition_id) do
      {:reconnected, intent} ->
        deliver_reconnected(agent_id, intent, ts)
        :reconnected

      other when other in [:noop, :mismatch] ->
        other
    end
  end

  @doc """
  Fails a matching transition. A terminal peer notice is emitted only while
  AgentStates still authoritatively says `disconnected`; a live old/rollback
  wrapper merely clears the intent.
  """
  def fail(agent_id, transition_id, reason) do
    case PlannedDisconnects.fail(agent_id, transition_id, normalize_reason(reason)) do
      {:failed, _intent} -> terminal_if_disconnected(agent_id)
      {:deferred, _intent} -> :deferred
      :noop -> :noop
    end
  end

  @doc "Callback used by the planned-intent timer."
  def timeout(agent_id, _transition_id), do: terminal_if_disconnected(agent_id)

  @doc "Purges one agent's intent without a notification."
  def delete(agent_id), do: PlannedDisconnects.delete(agent_id)

  defp terminal_if_disconnected(agent_id) do
    case AgentStates.snapshot()[agent_id] do
      %{"state" => "disconnected"} ->
        deliver_disconnected(agent_id, now())
        :disconnected

      _ ->
        :connected
    end
  end

  defp deliver_reconnecting(agent_id, intent, ts) do
    message = "peer #{agent_id} is temporarily unavailable: planned restart in progress"

    for {cid, peers} <- intent.targets, peer <- peers do
      payload = %{
        "to" => peer,
        "conversation_id" => cid,
        "turn_number" => 0,
        "kind" => "inform",
        "body" => message,
        "error" => %{"code" => "reconnecting", "message" => message},
        "meta" => %{"done" => false, "propose_next" => ""},
        "owner" => %{"kind" => "user", "id" => "system"}
      }

      SynthEnvelope.deliver(peer, SynthEnvelope.build(payload, ts))
    end

    warn_on_cap("planned reconnecting", agent_id, intent.unclaimed)
    :ok
  end

  defp deliver_reconnected(agent_id, intent, ts) do
    message = "peer #{agent_id} reconnected; resend with the same conversation_id if needed"

    for {cid, peers} <- intent.targets, peer <- peers do
      payload = %{
        "to" => peer,
        "conversation_id" => cid,
        "turn_number" => 0,
        "kind" => "inform",
        "body" => message,
        "meta" => %{"done" => false, "propose_next" => ""},
        "owner" => %{"kind" => "user", "id" => "system"}
      }

      SynthEnvelope.deliver(peer, SynthEnvelope.build(payload, ts))
    end

    :ok
  end

  defp deliver_disconnected(agent_id, ts) do
    message = "peer #{agent_id} is unreachable: wrapper disconnected"

    {targets, unclaimed} =
      ConversationStates.claim_unreachable_targets(agent_id, @max_unreachable_notices)

    for {cid, peers} <- targets, peer <- peers do
      payload = %{
        "to" => peer,
        "conversation_id" => cid,
        "turn_number" => 0,
        "kind" => "inform",
        "body" => message,
        "error" => %{"code" => "disconnected", "message" => message},
        "meta" => %{"done" => false, "propose_next" => ""},
        "owner" => %{"kind" => "user", "id" => "system"}
      }

      SynthEnvelope.deliver(peer, SynthEnvelope.build(payload, ts))
    end

    warn_on_cap("disconnect", agent_id, unclaimed)
    :ok
  end

  defp warn_on_cap(_label, _agent_id, 0), do: :ok

  defp warn_on_cap(label, agent_id, unclaimed) do
    Logger.warning(
      "#{label} notice cap hit for #{agent_id}: " <>
        "#{unclaimed} conversation(s) left unnotified"
    )
  end

  defp normalize_reason(reason) when is_binary(reason) do
    case reason do
      "spawn_failed" -> :spawn_failed
      other -> other
    end
  end

  defp normalize_reason(reason), do: reason

  defp now, do: DateTime.utc_now() |> DateTime.to_iso8601()
end
