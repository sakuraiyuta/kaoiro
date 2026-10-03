defmodule KaoiroServer.StatusLineWireTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.StatusLineWire

  @at "2026-10-03T12:00:00.000001Z"

  defp row(text, opts \\ []) do
    %{
      entry: %{seq: Keyword.get(opts, :seq, 3), text: text, updated_at: @at},
      head: Keyword.get(opts, :head, text || ""),
      truncated: Keyword.get(opts, :truncated, false),
      bytes: Keyword.get(opts, :bytes, if(text, do: byte_size(text), else: 0))
    }
  end

  defp truncated_row do
    row(String.duplicate("a", 600), head: String.duplicate("a", 512), truncated: true)
  end

  describe "a set line" do
    test "the directory field is the head, its flag, the size and the time" do
      assert StatusLineWire.directory_field(truncated_row()) == %{
               "head" => String.duplicate("a", 512),
               "truncated" => true,
               "bytes" => 600,
               "updated_at" => @at
             }
    end

    test "the snapshot entry and the live payload add the sequence, and the live one the agent" do
      snapshot = StatusLineWire.snapshot_entry(truncated_row())

      assert snapshot == %{
               "seq" => 3,
               "head" => String.duplicate("a", 512),
               "truncated" => true,
               "bytes" => 600,
               "updated_at" => @at
             }

      assert StatusLineWire.live_payload("a.one", truncated_row()) ==
               Map.put(snapshot, "agent_id", "a.one")
    end

    test "all three paths carry the same head fields" do
      row = truncated_row()
      directory = StatusLineWire.directory_field(row)
      snapshot = StatusLineWire.snapshot_entry(row)
      live = StatusLineWire.live_payload("a.one", row)

      for key <- ["head", "truncated", "bytes", "updated_at"] do
        assert directory[key] == snapshot[key]
        assert directory[key] == live[key]
      end
    end

    test "an oversized first grapheme is a valid empty head with truncated set" do
      row = row("e" <> String.duplicate("\u{0301}", 300), head: "", truncated: true, bytes: 601)

      assert %{"head" => "", "truncated" => true, "bytes" => 601} =
               StatusLineWire.directory_field(row)
    end
  end

  describe "a cleared line" do
    test "is omitted from the directory" do
      assert StatusLineWire.directory_field(row(nil)) == nil
    end

    test "is a stamped row in the snapshot and the live payload" do
      assert StatusLineWire.snapshot_entry(row(nil)) ==
               %{"seq" => 3, "cleared" => true, "updated_at" => @at}

      assert StatusLineWire.live_payload("a.one", row(nil)) ==
               %{"agent_id" => "a.one", "seq" => 3, "cleared" => true, "updated_at" => @at}
    end
  end

  describe "history and the peer read" do
    test "a history entry carries the full text and its size" do
      entry = %{seq: 2, text: "あいう", updated_at: @at}

      assert StatusLineWire.history_entry(entry) ==
               %{"seq" => 2, "text" => "あいう", "bytes" => 9, "updated_at" => @at}
    end

    test "a cleared history entry has a null text and no size" do
      assert StatusLineWire.history_entry(%{seq: 2, text: nil, updated_at: @at}) ==
               %{"seq" => 2, "text" => nil, "updated_at" => @at}
    end

    test "a peer read returns the full text, or null for no line and for a clear" do
      assert StatusLineWire.get_reply("a.one", row("full text")) ==
               %{"agent_id" => "a.one", "text" => "full text", "bytes" => 9, "updated_at" => @at}

      assert StatusLineWire.get_reply("a.one", nil) == %{
               "agent_id" => "a.one",
               "status_line" => nil
             }

      assert StatusLineWire.get_reply("a.one", row(nil)) == %{
               "agent_id" => "a.one",
               "status_line" => nil
             }
    end
  end
end
