defmodule KaoiroServer.AgentActivityTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.AgentActivity

  defp ts(second),
    do: "2026-07-28T00:00:#{String.pad_leading(Integer.to_string(second), 2, "0")}Z"

  defp env(agent_id, type \\ "state_change", sid \\ "sid-a") do
    %{"agent_id" => agent_id, "type" => type, "session_id" => sid}
  end

  setup do
    name = String.to_atom("activity_#{System.unique_integer([:positive])}")
    %{store: start_supervised!({AgentActivity, name: name, pending_ttl_ms: 20})}
  end

  test "unknown agent is bound to its owner and result increments once", %{store: store} do
    AgentActivity.record_envelope(env("a", "result"), self(), ts(1), server: store)
    :sys.get_state(store)

    assert %{owner: owner, session_start_observed: false, turns: 1, last_activity_at: activity} =
             AgentActivity.get("a", store)

    assert owner == self()
    assert activity == ts(1)
  end

  test "new session result resets before it increments", %{store: store} do
    AgentActivity.record_envelope(env("a", "result", "old"), self(), ts(1), server: store)
    :sys.get_state(store)
    AgentActivity.record_envelope(env("a", "result", "new"), self(), ts(2), server: store)
    :sys.get_state(store)

    assert %{
             session_id: "new",
             session_start_observed: true,
             turns: 1,
             session_started_at: started
           } =
             AgentActivity.get("a", store)

    assert started == ts(2)
  end

  test "matching join activates a pending transition and lazy sid adopts without reset", %{
    store: store
  } do
    assert :ok = AgentActivity.begin_transition("a", "p1", :restore, ts(1), server: store)
    assert :activated = AgentActivity.activate_or_rebind("a", self(), "p1", server: store)

    AgentActivity.record_envelope(env("a", "result", "lazy-sid"), self(), ts(2), server: store)
    :sys.get_state(store)

    assert %{session_id: "lazy-sid", awaiting_sid: false, turns: 1, session_started_at: started} =
             AgentActivity.get("a", store)

    assert started == ts(1)
  end

  test "old-owner casts cannot affect an activated generation", %{store: store} do
    old_owner = self()
    AgentActivity.record_envelope(env("a", "result", "old"), old_owner, ts(1), server: store)
    :sys.get_state(store)
    assert :ok = AgentActivity.begin_transition("a", "p1", :restore, ts(2), server: store)

    new_owner = spawn(fn -> Process.sleep(100) end)
    assert :activated = AgentActivity.activate_or_rebind("a", new_owner, "p1", server: store)
    AgentActivity.record_envelope(env("a", "result", "old"), old_owner, ts(3), server: store)
    :sys.get_state(store)

    assert %{owner: ^new_owner, turns: 0, session_id: nil} = AgentActivity.get("a", store)
  end

  test "begin から activate まで旧 current の result は継続計測される", %{store: store} do
    AgentActivity.record_envelope(env("a", "result", "old"), self(), ts(1), server: store)
    :sys.get_state(store)
    assert :ok = AgentActivity.begin_transition("a", "p1", :restore, ts(2), server: store)

    AgentActivity.record_envelope(env("a", "result", "old"), self(), ts(3), server: store)
    :sys.get_state(store)
    assert %{turns: 2, session_id: "old"} = AgentActivity.get("a", store)
  end

  test "restore failure keeps old current entry while spawn failure removes it", %{store: store} do
    AgentActivity.record_envelope(env("a", "result", "old"), self(), ts(1), server: store)
    :sys.get_state(store)
    :ok = AgentActivity.begin_transition("a", "restore", :restore, ts(2), server: store)
    assert :aborted = AgentActivity.resolve_transition("a", "restore", false, server: store)
    assert %{turns: 1, session_id: "old"} = AgentActivity.get("a", store)

    :ok = AgentActivity.begin_transition("fresh", "spawn", :spawn, ts(3), server: store)
    assert :aborted = AgentActivity.resolve_transition("fresh", "spawn", false, server: store)
    assert AgentActivity.get("fresh", store) == nil
  end

  test "superseded p1 join cannot activate p2 pending", %{store: store} do
    :ok = AgentActivity.begin_transition("a", "p1", :restore, ts(1), server: store)
    :ok = AgentActivity.begin_transition("a", "p2", :restore, ts(2), server: store)
    assert :rebound = AgentActivity.activate_or_rebind("a", self(), "p1", server: store)
    assert %{projection_suppressed: true} = AgentActivity.get("a", store)
    assert :activated = AgentActivity.activate_or_rebind("a", self(), "p2", server: store)

    assert %{session_started_at: started, projection_suppressed: false} =
             AgentActivity.get("a", store)

    assert started == ts(2)
  end

  test "error result も加算し log/state/IA は加算しない", %{store: store} do
    AgentActivity.record_envelope(env("a", "state_change"), self(), ts(1), server: store)
    AgentActivity.record_envelope(env("a", "log"), self(), ts(2), server: store)
    AgentActivity.record_envelope(env("a", "inter_agent_message"), self(), ts(3), server: store)
    AgentActivity.record_envelope(env("a", "result"), self(), ts(4), server: store)
    :sys.get_state(store)
    assert %{turns: 1} = AgentActivity.get("a", store)
  end

  test "L2 mismatch is force-suppressed even without an Activity pending", %{store: store} do
    assert :rebound =
             AgentActivity.activate_or_rebind("a", self(), "stale",
               reset_result: :mismatch,
               server: store
             )

    assert %{projection_suppressed: true} = AgentActivity.get("a", store)
  end

  test "legacy absent is force-suppressed and a consumed id reconnect is not", %{store: store} do
    :ok = AgentActivity.begin_transition("a", "p1", :reset, ts(1), server: store)

    assert :rebound =
             AgentActivity.activate_or_rebind("a", self(), :absent,
               reset_result: :legacy_absent,
               server: store
             )

    assert %{projection_suppressed: true} = AgentActivity.get("a", store)
    assert :activated = AgentActivity.activate_or_rebind("a", self(), "p1", server: store)
    assert %{projection_suppressed: false} = AgentActivity.get("a", store)
    assert :rebound = AgentActivity.activate_or_rebind("a", self(), "p1", server: store)
    assert %{projection_suppressed: false} = AgentActivity.get("a", store)
  end

  test "pending CAS, failure behavior, and ttl preserve newer transactions", %{store: store} do
    assert :ok = AgentActivity.begin_transition("a", "p1", :spawn, ts(1), server: store)
    assert :ok = AgentActivity.begin_transition("a", "p2", :restore, ts(2), server: store)
    assert :noop = AgentActivity.resolve_transition("a", "p1", false, server: store)
    assert :aborted = AgentActivity.resolve_transition("a", "p2", false, server: store)

    assert :ok = AgentActivity.begin_transition("a", "p3", :restore, ts(3), server: store)
    Process.sleep(30)
    assert :rebound = AgentActivity.activate_or_rebind("a", self(), "p3", server: store)
    assert %{projection_suppressed: false} = AgentActivity.get("a", store)
  end

  test "unmatched pending join suppresses projections until a trusted reset", %{store: store} do
    AgentActivity.record_envelope(env("a", "result", "old"), self(), ts(1), server: store)
    :sys.get_state(store)
    assert :ok = AgentActivity.begin_transition("a", "p1", :restore, ts(2), server: store)
    assert :rebound = AgentActivity.activate_or_rebind("a", self(), nil, server: store)
    assert %{projection_suppressed: true} = AgentActivity.get("a", store)

    AgentActivity.record_envelope(env("a", "state_change", "new"), self(), ts(3), server: store)
    :sys.get_state(store)
    assert %{projection_suppressed: false, session_id: "new"} = AgentActivity.get("a", store)
  end

  test "last_activity_at never regresses", %{store: store} do
    AgentActivity.record_envelope(env("a"), self(), ts(8), server: store)
    :sys.get_state(store)
    AgentActivity.record_envelope(env("a"), self(), ts(3), server: store)
    :sys.get_state(store)
    assert %{last_activity_at: activity} = AgentActivity.get("a", store)
    assert activity == ts(8)
  end
end
