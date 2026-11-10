defmodule KaoiroServer.PeerSessionResetReplyReasons do
  @moduledoc """
  Closed reply vocabulary of `peer_session_reset_request` (issue #677).
  Kept separate from `SessionResetRequestReplyReasons` because the peer
  path adds authorization and conversation refusals that the agent-self
  path never produces; folding them into the self vocabulary would let a
  self reset reply with a reason that cannot apply to it.

  `room_mismatch` and `rooms_unavailable` carry the same-room boundary
  ([issue #1078](https://github.com/sakuraiyuta/kaoiro/issues/1078)); they
  are the words the send path already answers, so a director reads one
  meaning for both refusals. They are not authority failures: the work
  grant stays valid, which is why they are separate from
  `reset_not_authorized` (ADR-0068 D1).
  """

  @reasons %{
    reset_not_authorized: "reset_not_authorized",
    work_control_unavailable: "work_control_unavailable",
    unknown_agent: "unknown_agent",
    unsupported_session_reset: "unsupported_session_reset",
    agent_in_conversation: "agent_in_conversation",
    agent_busy: "agent_busy",
    session_reset_pending: "session_reset_pending",
    runner_unavailable: "runner_unavailable",
    room_mismatch: "room_mismatch",
    rooms_unavailable: "rooms_unavailable"
  }

  @type value :: String.t()

  @spec values() :: [value()]
  def values, do: @reasons |> Map.values() |> Enum.sort()

  @spec normalize(term()) :: value()
  def normalize(:invalid_mode), do: Map.fetch!(@reasons, :unsupported_session_reset)
  def normalize({:invalid_value, _field}), do: Map.fetch!(@reasons, :unsupported_session_reset)

  def normalize(reason) when is_map_key(@reasons, reason), do: Map.fetch!(@reasons, reason)

  # Anything else is a server-internal shape; collapse to the transient
  # word so the requester retries rather than learning an internal path.
  def normalize(_reason), do: Map.fetch!(@reasons, :agent_busy)
end
