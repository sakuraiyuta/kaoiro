defmodule KaoiroServer.TransportLimits do
  @moduledoc """
  Shared limits for Phoenix transport frames.
  """

  alias Phoenix.Socket.Message
  alias Phoenix.Socket.Reply
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
    snapshot_payload_budget(event, key, %{})
  end

  @doc """
  Bytes available to `key` when the frame also contains `static_payload`.

  A projection that may need an incomplete marker must reserve that marker
  before admitting entries; otherwise an entry ledger can pass while the
  final transport frame does not.
  """
  def snapshot_payload_budget(event, key, static_payload)
      when is_binary(event) and is_binary(key) and is_map(static_payload) do
    payload = Map.put(static_payload, key, %{})
    @max_frame_bytes - @frame_safety_margin_bytes - frame_bytes(event, payload) + 2
  end

  @doc "Whether the production JSON serializer keeps this snapshot frame in budget."
  def snapshot_frame_fits?(event, payload) when is_binary(event) and is_map(payload) do
    push_frame_fits?("agents:lobby", event, payload)
  end

  @doc "Whether a channel push fits the production JSON frame budget."
  def push_frame_fits?(topic, event, payload)
      when is_binary(topic) and is_binary(event) and is_map(payload) do
    push_frame_bytes(topic, event, payload) <= @max_frame_bytes - @frame_safety_margin_bytes
  end

  @doc "Whether a successful channel reply fits the production JSON frame budget."
  def reply_frame_fits?(topic, response) when is_binary(topic) and is_map(response) do
    reply_frame_bytes(topic, response) <= @max_frame_bytes - @frame_safety_margin_bytes
  end

  @doc "Bytes still available after an already-shaped push payload."
  def push_payload_budget(topic, event, payload)
      when is_binary(topic) and is_binary(event) and is_map(payload) do
    @max_frame_bytes - @frame_safety_margin_bytes - push_frame_bytes(topic, event, payload)
  end

  @doc "Bytes still available after an already-shaped successful reply."
  def reply_payload_budget(topic, response) when is_binary(topic) and is_map(response) do
    @max_frame_bytes - @frame_safety_margin_bytes - reply_frame_bytes(topic, response)
  end

  @doc "Takes an ordered list prefix whose JSON fragments fit `budget` bytes."
  def bounded_list(items, budget) when is_list(items) and is_integer(budget) do
    Enum.reduce_while(items, {[], 0}, fn item, {kept, used} ->
      item_bytes = json_bytes(item) + if kept == [], do: 0, else: 1

      if used + item_bytes <= budget do
        {:cont, {[item | kept], used + item_bytes}}
      else
        {:halt, {kept, used}}
      end
    end)
    |> then(fn {kept, _used} -> Enum.reverse(kept) end)
  end

  @doc "Takes an ordered map-entry prefix whose JSON fragments fit `budget` bytes."
  def bounded_map(entries, budget) when is_list(entries) and is_integer(budget) do
    Enum.reduce_while(entries, {%{}, 0}, fn {key, value}, {kept, used} ->
      entry_bytes =
        json_bytes(key) + 1 + json_bytes(value) + if map_size(kept) == 0, do: 0, else: 1

      if used + entry_bytes <= budget do
        {:cont, {Map.put(kept, key, value), used + entry_bytes}}
      else
        {:halt, {kept, used}}
      end
    end)
    |> elem(0)
  end

  @doc """
  Projects each ordered pane as its newest list suffix within one shared JSON ledger.

  The returned byte count is the exact increase from replacing an empty JSON
  object with the projected map entries. Oversized panes are skipped so a
  later, smaller pane can still fit.
  """
  def bounded_map_of_newest_suffixes(entries, budget)
      when is_map(entries) and is_integer(budget) do
    entries
    |> Enum.sort_by(fn {key, _items} -> key end)
    |> Enum.reduce({%{}, false, 0}, fn {key, items}, {projected, incomplete?, used} ->
      case items do
        [] ->
          {projected, incomplete?, used}

        _ ->
          separator_bytes = if map_size(projected) == 0, do: 0, else: 1
          entry_prefix_bytes = json_bytes(key) + 1 + separator_bytes

          {suffix, item_bytes} =
            bounded_newest_suffix(items, budget - used - entry_prefix_bytes - 2)

          if suffix == [] do
            {projected, true, used}
          else
            entry_bytes = entry_prefix_bytes + 2 + item_bytes

            {
              Map.put(projected, key, suffix),
              incomplete? or length(suffix) < length(items),
              used + entry_bytes
            }
          end
      end
    end)
  end

  @doc """
  Projects map entries with a shared JSON ledger without reserializing the map.

  The returned byte count is the exact increase from replacing an empty JSON
  object with the projected map entries. Entries that do not fit do not stop
  later smaller entries from being considered.
  """
  def bounded_map_with_ledger(entries, budget) when is_map(entries) and is_integer(budget) do
    entries
    |> Enum.sort_by(fn {key, _value} -> key end)
    |> Enum.reduce({%{}, false, 0}, fn {key, value}, {projected, incomplete?, used} ->
      entry_bytes =
        json_bytes(key) + 1 + json_bytes(value) + if map_size(projected) == 0, do: 0, else: 1

      if used + entry_bytes <= budget do
        {Map.put(projected, key, value), incomplete?, used + entry_bytes}
      else
        {projected, true, used}
      end
    end)
  end

  @doc "Measures the exact production text frame shape used by Phoenix Channels."
  def frame_bytes(event, payload) when is_binary(event) and is_map(payload) do
    push_frame_bytes("agents:lobby", event, payload)
  end

  @doc "Measures the exact production text frame shape of a channel push."
  def push_frame_bytes(topic, event, payload)
      when is_binary(topic) and is_binary(event) and is_map(payload) do
    message = %Message{
      topic: topic,
      event: event,
      payload: Map.put_new(payload, "version", "0"),
      join_ref: nil,
      ref: nil
    }

    {:socket_push, :text, encoded} = JSONSerializer.encode!(message)
    IO.iodata_length(encoded)
  end

  @doc "Measures the exact production text frame shape of a successful channel reply."
  def reply_frame_bytes(topic, response) when is_binary(topic) and is_map(response) do
    reply = %Reply{
      topic: topic,
      status: :ok,
      payload: response,
      join_ref: nil,
      ref: nil
    }

    {:socket_push, :text, encoded} = JSONSerializer.encode!(reply)
    IO.iodata_length(encoded)
  end

  defp bounded_newest_suffix(items, budget) do
    items
    |> Enum.reverse()
    |> Enum.reduce_while({[], 0}, fn item, {suffix, used} ->
      item_bytes = json_bytes(item) + if suffix == [], do: 0, else: 1

      if used + item_bytes <= budget do
        {:cont, {[item | suffix], used + item_bytes}}
      else
        {:halt, {suffix, used}}
      end
    end)
  end

  defp json_bytes(value), do: value |> Jason.encode!() |> byte_size()
end
