defmodule KaoiroServer.StatusLineWire do
  @moduledoc """
  The wire forms of an agent status line (issue 482 design r5 section 6).

  Every path that puts a committed line on a wire builds it here, from the row
  `AgentStatusLines` publishes, so the directory, the join snapshot and the live
  event cannot disagree on `head`, `truncated`, `bytes` or `updated_at`.

  A row is `%{entry: %{seq, text, updated_at}, head, truncated, bytes}`. A clear
  is an entry whose `text` is `nil`; it travels as a stamped `cleared` row so a
  client can reject an older set that arrives later.
  """

  @type row :: %{
          entry: %{seq: pos_integer(), text: String.t() | nil, updated_at: String.t()},
          head: String.t(),
          truncated: boolean(),
          bytes: non_neg_integer()
        }

  @doc "`list_agents` field, or `nil` when the line is cleared (the key is omitted)."
  @spec directory_field(row()) :: map() | nil
  def directory_field(%{entry: %{text: nil}}), do: nil
  def directory_field(row), do: head_fields(row)

  @doc "One agent's entry in the `status_line_snapshot` map."
  @spec snapshot_entry(row()) :: map()
  def snapshot_entry(%{entry: %{text: nil} = entry}), do: cleared(entry)
  def snapshot_entry(%{entry: entry} = row), do: Map.put(head_fields(row), "seq", entry.seq)

  @doc "The live `status_line` event payload (flat, with the agent id)."
  @spec live_payload(String.t(), row()) :: map()
  def live_payload(agent_id, row), do: Map.put(snapshot_entry(row), "agent_id", agent_id)

  @doc "One entry of a `status_line_history` reply: the full text, newest first."
  @spec history_entry(%{seq: pos_integer(), text: String.t() | nil, updated_at: String.t()}) ::
          map()
  def history_entry(%{text: nil} = entry) do
    %{"seq" => entry.seq, "text" => nil, "updated_at" => entry.updated_at}
  end

  def history_entry(entry) do
    %{
      "seq" => entry.seq,
      "text" => entry.text,
      "bytes" => byte_size(entry.text),
      "updated_at" => entry.updated_at
    }
  end

  @doc "A `status_line_get` reply for a peer: the full latest text, or `nil`."
  @spec get_reply(String.t(), row() | nil) :: map()
  def get_reply(agent_id, nil), do: %{"agent_id" => agent_id, "status_line" => nil}
  def get_reply(agent_id, %{entry: %{text: nil}}), do: get_reply(agent_id, nil)

  def get_reply(agent_id, %{entry: entry}) do
    %{
      "agent_id" => agent_id,
      "text" => entry.text,
      "bytes" => byte_size(entry.text),
      "updated_at" => entry.updated_at
    }
  end

  defp head_fields(%{entry: entry, head: head, truncated: truncated, bytes: bytes}) do
    %{
      "head" => head,
      "truncated" => truncated,
      "bytes" => bytes,
      "updated_at" => entry.updated_at
    }
  end

  defp cleared(entry) do
    %{"seq" => entry.seq, "cleared" => true, "updated_at" => entry.updated_at}
  end
end
