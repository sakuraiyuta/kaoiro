defmodule KaoiroServer.SessionLifecycleEventsTest do
  use ExUnit.Case, async: false

  import KaoiroServer.TestTeardown

  alias KaoiroServer.SessionLifecycleEvents

  setup do
    name = :"session_lifecycle_events_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
    File.rm(path)
    {:ok, _pid} = SessionLifecycleEvents.start_link(name: name, path: path, cap: 3)

    on_exit(fn ->
      stop_quietly(name)
      File.rm(path)
    end)

    %{name: name, path: path}
  end

  test "append then list_for_agent returns newest first", %{name: name} do
    assert :ok = SessionLifecycleEvents.append("a.1", "compacting", nil, "T1", name)

    assert :ok =
             SessionLifecycleEvents.append(
               "a.1",
               "compact_boundary",
               "request_compact",
               "T2",
               name
             )

    assert SessionLifecycleEvents.list_for_agent("a.1", name) == [
             %{kind: "compact_boundary", trigger: "request_compact", at: "T2"},
             %{kind: "compacting", trigger: nil, at: "T1"}
           ]
  end

  test "unknown agent returns an empty list", %{name: name} do
    assert SessionLifecycleEvents.list_for_agent("a.none", name) == []
  end

  test "each agent's timeline is independent", %{name: name} do
    SessionLifecycleEvents.append("a.1", "compacting", nil, "T1", name)
    SessionLifecycleEvents.append("a.2", "conversation_reset", nil, "T1", name)

    assert length(SessionLifecycleEvents.list_for_agent("a.1", name)) == 1
    assert length(SessionLifecycleEvents.list_for_agent("a.2", name)) == 1

    assert [%{kind: "compacting"}] = SessionLifecycleEvents.list_for_agent("a.1", name)
    assert [%{kind: "conversation_reset"}] = SessionLifecycleEvents.list_for_agent("a.2", name)
  end

  test "cap discards the oldest entries first (setup cap: 3)", %{name: name} do
    for i <- 1..5 do
      SessionLifecycleEvents.append("a.cap", "kind-#{i}", nil, "T#{i}", name)
    end

    kinds = SessionLifecycleEvents.list_for_agent("a.cap", name) |> Enum.map(& &1.kind)
    assert kinds == ["kind-5", "kind-4", "kind-3"]
  end

  test "restart retains the timeline (DETS persistence)", %{name: name, path: path} do
    SessionLifecycleEvents.append("a.restart", "compacting", nil, "T1", name)
    SessionLifecycleEvents.append("a.restart", "compact_boundary", "sdk_auto", "T2", name)

    GenServer.stop(Process.whereis(name))
    {:ok, _pid} = SessionLifecycleEvents.start_link(name: name, path: path, cap: 3)

    assert SessionLifecycleEvents.list_for_agent("a.restart", name) == [
             %{kind: "compact_boundary", trigger: "sdk_auto", at: "T2"},
             %{kind: "compacting", trigger: nil, at: "T1"}
           ]
  end

  test "corrupt store file is recreated rather than crashing boot", %{name: name, path: path} do
    GenServer.stop(Process.whereis(name))
    File.write!(path, "not a dets file")

    assert {:ok, pid} = SessionLifecycleEvents.start_link(name: name, path: path, cap: 3)
    assert Process.alive?(pid)
    assert SessionLifecycleEvents.list_for_agent("a.any", name) == []
  end
end
