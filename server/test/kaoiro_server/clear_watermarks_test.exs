defmodule KaoiroServer.ClearWatermarksTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.ClearWatermarks

  setup do
    name = :"cw_#{System.unique_integer([:positive])}"
    path = Path.join(System.tmp_dir!(), "#{name}.dets")
    File.rm(path)
    {:ok, pid} = ClearWatermarks.start_link(name: name, path: path)

    on_exit(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid)
      File.rm(path)
    end)

    %{server: name, path: path}
  end

  defp wait_until(predicate, attempts \\ 50) do
    cond do
      predicate.() -> :ok
      attempts <= 0 -> :timeout
      true -> Process.sleep(5) && wait_until(predicate, attempts - 1)
    end
  end

  test "record してから get すると ISO ts が返る", %{server: server} do
    ClearWatermarks.record("a.1", "2026-07-23T15:00:00.000000Z", server)
    :ok = wait_until(fn -> ClearWatermarks.get("a.1", server) != nil end)
    assert ClearWatermarks.get("a.1", server) == "2026-07-23T15:00:00.000000Z"
  end

  test "未知 agent は nil", %{server: server} do
    assert ClearWatermarks.get("a.none", server) == nil
  end

  test "新しい ts への更新は上書き、古い ts への更新は無視 (単調前進)", %{server: server} do
    ClearWatermarks.record("a.2", "2026-07-23T15:00:00.000000Z", server)
    :ok = wait_until(fn -> ClearWatermarks.get("a.2", server) != nil end)

    # 新しい ts は上書き。
    ClearWatermarks.record("a.2", "2026-07-23T16:00:00.000000Z", server)

    :ok =
      wait_until(fn ->
        ClearWatermarks.get("a.2", server) == "2026-07-23T16:00:00.000000Z"
      end)

    # 古い ts (out-of-order retry) は無視 — さもないと過去の IA が再露出する。
    ClearWatermarks.record("a.2", "2026-07-23T14:00:00.000000Z", server)
    # 明示 sleep で cast の順序を待つ。
    Process.sleep(20)
    assert ClearWatermarks.get("a.2", server) == "2026-07-23T16:00:00.000000Z"
  end

  test "同一 DETS ファイルからの再起動で ts が残る", %{server: server, path: path} do
    ClearWatermarks.record("a.3", "2026-07-23T15:30:00.000000Z", server)

    :ok =
      wait_until(fn ->
        ClearWatermarks.get("a.3", server) == "2026-07-23T15:30:00.000000Z"
      end)

    :ok = GenServer.stop(server)

    name2 = :"cw_restart_#{System.unique_integer([:positive])}"
    {:ok, _pid} = ClearWatermarks.start_link(name: name2, path: path)
    assert ClearWatermarks.get("a.3", name2) == "2026-07-23T15:30:00.000000Z"
    GenServer.stop(name2)
  end

  test "all は全 watermark 辞書を返す", %{server: server} do
    ClearWatermarks.record("a.4", "2026-07-23T15:00:00.000000Z", server)
    ClearWatermarks.record("a.5", "2026-07-23T15:01:00.000000Z", server)
    :ok = wait_until(fn -> ClearWatermarks.get("a.5", server) != nil end)
    all = ClearWatermarks.all(server)
    assert all["a.4"] == "2026-07-23T15:00:00.000000Z"
    assert all["a.5"] == "2026-07-23T15:01:00.000000Z"
  end

  test "delete で ts が消え、再起動後も残らない", %{server: server, path: path} do
    ClearWatermarks.record("a.6", "2026-07-23T15:00:00.000000Z", server)
    :ok = wait_until(fn -> ClearWatermarks.get("a.6", server) != nil end)

    assert ClearWatermarks.delete("a.6", server) == :ok
    assert ClearWatermarks.get("a.6", server) == nil

    :ok = GenServer.stop(server)
    name2 = :"cw_delete_#{System.unique_integer([:positive])}"
    {:ok, _pid} = ClearWatermarks.start_link(name: name2, path: path)
    assert ClearWatermarks.get("a.6", name2) == nil
    GenServer.stop(name2)
  end

  test "delete は未知 agent でも :ok (冪等)", %{server: server} do
    assert ClearWatermarks.delete("a.none", server) == :ok
  end
end
