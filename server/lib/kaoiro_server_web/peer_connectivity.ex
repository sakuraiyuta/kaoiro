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

  @doc "Atomically records a planned-window IA bounce target."
  def track_bounce(agent_id, conversation_id, peer_id) do
    PlannedDisconnects.track_bounce(agent_id, conversation_id, peer_id)
  end

  @doc """
  Fails a matching transition. AgentStates chooses terminal `disconnected`
  while down or neutral `reconnected` while the old/rollback wrapper remains
  reachable. Either outcome closes every tracked bounce target.
  """
  def fail(agent_id, transition_id, reason) do
    case PlannedDisconnects.fail(agent_id, transition_id, normalize_reason(reason)) do
      {:failed, intent} -> close_for_authoritative_state(agent_id, intent)
      {:deferred, _intent} -> :deferred
      :noop -> :noop
    end
  end

  @doc "Callback used by the planned-intent timer."
  def timeout(agent_id, _transition_id, intent),
    do: close_for_authoritative_state(agent_id, intent)

  @doc "Cancels a planned transition for operator stop and closes it terminally."
  def stop(agent_id) do
    case PlannedDisconnects.cancel(agent_id) do
      {:cancelled, intent} ->
        deliver_disconnected(agent_id, now(), intent.targets)
        :disconnected

      :noop ->
        :noop
    end
  end

  @doc "Cancels an exact setup failure and closes it from authoritative reachability."
  def abort_setup(agent_id, transition_id) do
    case PlannedDisconnects.cancel_transition(agent_id, transition_id) do
      {:cancelled, intent} ->
        close_for_authoritative_state(agent_id, intent)

      :noop ->
        :noop
    end
  end

  @doc "Purges one disconnected agent's intent after closing every tracked target."
  def delete(agent_id) do
    case PlannedDisconnects.cancel(agent_id) do
      {:cancelled, intent} ->
        deliver_disconnected(agent_id, now(), intent.targets, true)
        :disconnected

      :noop ->
        :noop
    end
  end

  defp close_for_authoritative_state(agent_id, intent) do
    case AgentStates.snapshot()[agent_id] do
      %{"state" => "disconnected"} ->
        deliver_disconnected(agent_id, now(), intent.targets)
        :disconnected

      _ ->
        # The incumbent/rollback wrapper is still live. A bounce may already
        # have told a sender to wait, so clearing silently would strand it.
        # `reconnected` is the protocol's reachability-restored outcome even
        # when no physical reconnect was needed.
        deliver_reconnected(agent_id, intent, now())
        :connected
    end
  end

  defp deliver_reconnecting(agent_id, intent, ts) do
    message = "peer #{agent_id} is temporarily unavailable: planned restart in progress"

    for {cid, peers} <- intent.notice_targets, peer <- peers do
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

    warn_on_snapshot_overflow(agent_id, intent.dropped_targets, intent.unclaimed)
    :ok
  end

  defp deliver_reconnected(agent_id, intent, ts) do
    message = "peer #{agent_id} is reachable; resend with the same conversation_id if needed"

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

  defp deliver_disconnected(agent_id, ts, required_targets \\ [], fill_remaining \\ false)

  defp deliver_disconnected(agent_id, ts, required_targets, fill_remaining) do
    message = "peer #{agent_id} is unreachable: wrapper disconnected"

    {targets, unclaimed} =
      cond do
        required_targets == [] ->
          # Preserve the ordinary unexpected-disconnect path exactly.
          ConversationStates.claim_unreachable_targets(
            agent_id,
            PlannedDisconnects.max_unreachable_notices()
          )

        fill_remaining ->
          :ok = ConversationStates.mark_terminal_targets(agent_id, required_targets)

          {ordinary_targets, unclaimed} =
            ConversationStates.claim_unreachable_targets(
              agent_id,
              PlannedDisconnects.max_unreachable_notices() - target_count(required_targets)
            )

          {required_targets ++ ordinary_targets, unclaimed}

        true ->
          :ok = ConversationStates.mark_terminal_targets(agent_id, required_targets)
          {required_targets, 0}
      end

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

  defp target_count(targets) do
    Enum.reduce(targets, 0, fn {_conversation_id, peers}, count ->
      count + length(peers)
    end)
  end

  defp warn_on_cap(_label, _agent_id, 0), do: :ok

  defp warn_on_cap(label, agent_id, unclaimed) do
    Logger.warning(
      "#{label} notice cap hit for #{agent_id}: " <>
        "#{unclaimed} conversation(s) left unnotified"
    )
  end

  defp warn_on_snapshot_overflow(_agent_id, [], 0), do: :ok

  defp warn_on_snapshot_overflow(agent_id, dropped_targets, provider_unclaimed) do
    dropped_count =
      Enum.reduce(dropped_targets, 0, fn {_conversation_id, peers}, count ->
        count + length(peers)
      end)

    Logger.warning(
      "planned reconnecting snapshot cap hit for #{agent_id}: " <>
        "dropped_count=#{dropped_count} dropped_targets=#{inspect(dropped_targets)} " <>
        "provider_unclaimed=#{provider_unclaimed}"
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
