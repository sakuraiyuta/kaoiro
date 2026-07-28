defmodule KaoiroServer.InterAgentHistoryTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.InterAgentHistory

  setup do
    name = :"iah_#{System.unique_integer([:positive])}"
    path = Path.join(System.tmp_dir!(), "#{name}.dets")
    File.rm(path)
    {:ok, pid} = InterAgentHistory.start_link(name: name, path: path, max_per_agent: 3)

    on_exit(fn ->
      # #169: alive? と stop の間にテスト終了のリンク死が挟まると
      # `no process` で teardown だけが落ちる。詳細は
      # session_starts_test.exs の同 cushion を参照。
      try do
        if Process.alive?(pid), do: GenServer.stop(pid)
      catch
        :exit, _ -> :ok
      end

      File.rm(path)
    end)

    %{server: name, path: path}
  end

  defp envelope(from, to, turn, body \\ nil) do
    %{
      "version" => "0",
      "agent_id" => from,
      "persona" => %{"id" => from, "name" => from, "sprite_set" => from},
      "ts" => "2026-07-13T00:00:0#{turn}Z",
      "seq" => turn,
      "type" => "inter_agent_message",
      "state" => "tool_running",
      "payload" => %{
        "to" => to,
        "conversation_id" => "cid-1",
        "turn_number" => turn,
        "kind" => "inform",
        "body" => body || "m#{turn}"
      },
      "ext" => %{}
    }
  end

  test "append/list_for/all は sender-keyed chronological history を返す", %{server: server} do
    e1 = envelope("a", "b", 1)
    e2 = envelope("a", "b", 2)
    assert :ok = InterAgentHistory.append(e1, server)
    assert :ok = InterAgentHistory.append(e2, server)
    assert InterAgentHistory.list_for("a", server) == [e1, e2]
    assert InterAgentHistory.all(server) == %{"a" => [e1, e2]}
  end

  test "stable key が同じ retry は冪等", %{server: server} do
    original = envelope("a", "b", 1, "first")
    retry = envelope("a", "b", 1, "retry")
    assert :ok = InterAgentHistory.append(original, server)
    assert :ok = InterAgentHistory.append(retry, server)
    assert InterAgentHistory.list_for("a", server) == [original]
  end

  test "per-sender cap は newest entries を残し順序を維持", %{server: server} do
    Enum.each(1..5, &InterAgentHistory.append(envelope("a", "b", &1), server))
    assert Enum.map(InterAgentHistory.list_for("a", server), & &1["seq"]) == [3, 4, 5]
  end

  test "同じ DETS file の再起動後も復元する", %{server: server, path: path} do
    e1 = envelope("a", "b", 1)
    assert :ok = InterAgentHistory.append(e1, server)
    :ok = GenServer.stop(server)

    name2 = :"iah_restart_#{System.unique_integer([:positive])}"
    {:ok, _pid} = InterAgentHistory.start_link(name: name2, path: path, max_per_agent: 3)
    assert InterAgentHistory.list_for("a", name2) == [e1]
    GenServer.stop(name2)
  end

  test "delete_agent は sender/to 関連をpurgeし無関係を残す", %{server: server} do
    outgoing = envelope("a", "b", 1)
    incoming = envelope("c", "a", 1)
    unrelated = envelope("c", "d", 2)
    Enum.each([outgoing, incoming, unrelated], &InterAgentHistory.append(&1, server))

    assert :ok = InterAgentHistory.delete_agent("a", server)
    assert InterAgentHistory.all(server) == %{"c" => [unrelated]}
    assert :ok = InterAgentHistory.delete_agent("missing", server)
  end

  test "malformed envelope は保存しない", %{server: server} do
    assert {:error, :invalid_inter_agent_envelope} =
             InterAgentHistory.append(%{"type" => "inter_agent_message"}, server)

    assert InterAgentHistory.all(server) == %{}
  end
end
