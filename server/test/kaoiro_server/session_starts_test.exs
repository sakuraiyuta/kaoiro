defmodule KaoiroServer.SessionStartsTest do
  use ExUnit.Case, async: false

  import KaoiroServer.TestTeardown

  alias KaoiroServer.SessionStarts

  setup do
    name = :"session_starts_#{System.unique_integer([:positive])}"
    path = Path.join(System.tmp_dir!(), "#{name}.dets")
    File.rm(path)
    {:ok, _pid} = SessionStarts.start_link(name: name, path: path)

    on_exit(fn ->
      # #169 / #171: ExUnit のリンク死と stop が競合して teardown だけが
      # 落ちる (full run の負荷下でのみ出る)。良性の exit だけ吸収する
      # — テスト本体は完了済みで、DETS は書き込みごとに sync 済み、
      # owner 死亡時に閉じられる (詳細は KaoiroServer.TestTeardown)。
      stop_quietly(name)

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
