defmodule KaoiroServer.DisconnectAttribution do
  @moduledoc false

  @pairs %{
    "operator" => MapSet.new(["stop"]),
    "runner" => MapSet.new(["stop"]),
    "agent_self" => MapSet.new(["stop", "quota_exhausted", "crash"]),
    "unplanned" => MapSet.new(["socket_lost"])
  }

  @default %{"origin" => "unplanned", "reason" => "socket_lost"}

  def default, do: @default

  def valid?(%{"origin" => origin, "reason" => reason}) when is_binary(reason),
    do: Map.has_key?(@pairs, origin) and MapSet.member?(@pairs[origin], reason)

  def valid?(_other), do: false

  def intentional?(%{"origin" => origin} = disconnect),
    do: origin in ["operator", "runner", "agent_self"] and valid?(disconnect)

  def intentional?(_other), do: false
end
