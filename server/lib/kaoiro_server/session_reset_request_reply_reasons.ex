defmodule KaoiroServer.SessionResetRequestReplyReasons do
  @moduledoc false

  @reasons %{
    agent_busy: "agent_busy",
    session_reset_pending: "session_reset_pending",
    unsupported_session_reset: "unsupported_session_reset",
    runner_unavailable: "runner_unavailable"
  }

  @type value :: String.t()

  @spec values() :: [value()]
  def values, do: @reasons |> Map.values() |> Enum.sort()

  @spec normalize(term()) :: value()
  def normalize(:invalid_mode), do: Map.fetch!(@reasons, :unsupported_session_reset)
  def normalize({:invalid_value, _field}), do: Map.fetch!(@reasons, :unsupported_session_reset)

  def normalize(:unsupported_session_reset),
    do: Map.fetch!(@reasons, :unsupported_session_reset)

  def normalize(reason)
      when reason in [:agent_busy, :session_reset_pending, :runner_unavailable],
      do: Map.fetch!(@reasons, reason)

  def normalize(_reason), do: Map.fetch!(@reasons, :agent_busy)
end
