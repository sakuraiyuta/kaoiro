defmodule KaoiroServer.SessionStartsTest do
  use ExUnit.Case, async: false

  alias KaoiroServer.SessionStarts

  setup do
    name = :"session_starts_#{System.unique_integer([:positive])}"
    path = Path.join(System.tmp_dir!(), "#{name}.dets")
    File.rm(path)
    {:ok, _pid} = SessionStarts.start_link(name: name, path: path)

    on_exit(fn ->
      if current = Process.whereis(name), do: GenServer.stop(current)
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
end
