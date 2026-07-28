defmodule KaoiroServer.SessionStartsTest do
  use ExUnit.Case, async: false

  alias KaoiroServer.SessionStarts

  setup do
    name = :"session_starts_#{System.unique_integer([:positive])}"
    path = Path.join(System.tmp_dir!(), "#{name}.dets")
    File.rm(path)
    {:ok, _pid} = SessionStarts.start_link(name: name, path: path)

    on_exit(fn ->
      # #169: ふじ 4th advisory 3 (2026-07-23) と同型の TOCTOU。ExUnit は
      # テスト終了時にテストプロセスを落とし、`start_link` でリンクした
      # この GenServer も巻き添えで死ぬ。on_exit は別プロセスなので、
      # whereis が生きて見えた直後に死ぬと GenServer.stop が
      # `no process` で exit し、本体が通っているのに teardown だけが
      # 落ちる。full run の負荷下でのみ出る (単体実行では再現しない)。
      # try で cushion する — テスト本体は完了済みで、DETS は書き込み
      # ごとに sync 済み、owner 死亡時に閉じられる。
      try do
        if current = Process.whereis(name), do: GenServer.stop(current)
      catch
        :exit, _ -> :ok
      end

      File.rm(path)
    end)

    %{name: name, path: path}
  end

  test "same sid retry is idempotent and lazy sid can be adopted", %{name: name} do
    assert {:ok, {order, display, nil}} =
             SessionStarts.advance_transition("a.start", nil, "sess-old", name)

    assert {:ok, {^order, ^display, "sess-new"}} =
             SessionStarts.adopt_pending_sid("a.start", "sess-new", "sess-old", name)

    assert {:ok, {^order, ^display, "sess-new"}} =
             SessionStarts.advance_transition("a.start", "sess-new", name)
  end

  test "restart retains start record", %{name: name, path: path} do
    assert {:ok, {order, display, "sess-a"}} =
             SessionStarts.advance_transition("a.restart", "sess-a", name)

    pid = Process.whereis(name)
    GenServer.stop(pid)
    {:ok, _pid} = SessionStarts.start_link(name: name, path: path)

    assert SessionStarts.get("a.restart", name) == {order, display, "sess-a"}
  end

  test "pending lazy start survives restart and adopts without reallocating", %{
    name: name,
    path: path
  } do
    assert {:ok, {order, display, nil}} =
             SessionStarts.advance_transition("a.pending", nil, "sess-old", name)

    GenServer.stop(Process.whereis(name))
    {:ok, _pid} = SessionStarts.start_link(name: name, path: path)

    assert {:ok, {^order, ^display, "sess-new"}} =
             SessionStarts.adopt_pending_sid("a.pending", "sess-new", "sess-old", name)
  end
end
