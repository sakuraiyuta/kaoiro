defmodule KaoiroServer.TransportLimits do
  @moduledoc """
  Shared limits for Phoenix transport frames.
  """

  alias Phoenix.Socket.Message
  alias Phoenix.Socket.V2.JSONSerializer

  @max_frame_bytes 8_000_000
  @frame_safety_margin_bytes 1_024
  @wire_projection_agents 200

  @doc "The maximum size accepted by every WebSocket endpoint frame."
  def max_frame_bytes, do: @max_frame_bytes

  @doc """
  The realistic agent ceiling for snapshot projections.

  200 realistic 4.2KB envelopes occupy about 0.84MB; deployments normally
  run only a few tens. Raising this is intentionally a one-constant change.
  """
  def wire_projection_agents, do: @wire_projection_agents

  @doc """
  Bytes available to a JSON map that replaces the empty value of `key`.

  The reserve covers channel reference growth between the join-time
  measurement and the transport write.
  """
  def snapshot_payload_budget(event, key) when is_binary(event) and is_binary(key) do
    @max_frame_bytes - @frame_safety_margin_bytes - frame_bytes(event, %{key => %{}}) + 2
  end

  @doc "Whether the production JSON serializer keeps this snapshot frame in budget."
  def snapshot_frame_fits?(event, payload) when is_binary(event) and is_map(payload) do
    frame_bytes(event, payload) <= @max_frame_bytes - @frame_safety_margin_bytes
  end

  @doc "Measures the exact production text frame shape used by Phoenix Channels."
  def frame_bytes(event, payload) when is_binary(event) and is_map(payload) do
    message = %Message{
      topic: "agents:lobby",
      event: event,
      payload: Map.put_new(payload, "version", "0"),
      join_ref: nil,
      ref: nil
    }

    {:socket_push, :text, encoded} = JSONSerializer.encode!(message)
    IO.iodata_length(encoded)
  end
end
