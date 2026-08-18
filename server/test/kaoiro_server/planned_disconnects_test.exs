defmodule KaoiroServer.PlannedDisconnectsTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.PlannedDisconnects

  defp start_tracker(name, opts \\ []) do
    start_supervised!({PlannedDisconnects, Keyword.put(opts, :name, name)})
    name
  end

  test "default production wiring starts and snapshots ConversationStates without injection" do
    name = start_tracker(:pd_default_path)

    assert :ok = PlannedDisconnects.begin("pd.default", "tr-default", :restart, name)

    assert {:planned, %{phase: :disconnected, targets: [], unclaimed: 0}} =
             PlannedDisconnects.disconnect("pd.default", name)

    assert {:reconnected, %{transition_id: "tr-default"}} =
             PlannedDisconnects.confirm_connection("pd.default", "tr-default", name)
  end

  test "one intent per agent; disconnect snapshots bounded targets and only exact join consumes it" do
    owner = self()

    provider = fn agent_id, limit ->
      send(owner, {:provider, agent_id, limit})
      {[{"cid-1", ["peer.a"]}], 2}
    end

    name = start_tracker(:pd_state_machine, target_provider: provider)

    assert :ok = PlannedDisconnects.begin("agent.a", "tr-1", :switch_session, name)

    assert {:error, :agent_busy} =
             PlannedDisconnects.begin("agent.a", "tr-2", :restart, name)

    assert {:planned,
            %{
              phase: :disconnected,
              transition_id: "tr-1",
              kind: :switch_session,
              targets: [{"cid-1", ["peer.a"]}],
              unclaimed: 2
            }} = PlannedDisconnects.disconnect("agent.a", name)

    assert_receive {:provider, "agent.a", 50}
    assert :noop = PlannedDisconnects.disconnect("agent.a", name)
    assert :mismatch = PlannedDisconnects.confirm_connection("agent.a", "stale", name)
    assert PlannedDisconnects.active?("agent.a", name)

    assert {:reconnected, %{targets: [{"cid-1", ["peer.a"]}]}} =
             PlannedDisconnects.confirm_connection("agent.a", "tr-1", name)

    refute PlannedDisconnects.active?("agent.a", name)
  end

  test "spawn_failed defers to rollback join; terminal failure is token-CAS and idempotent" do
    name = start_tracker(:pd_failure)

    assert :ok = PlannedDisconnects.begin("agent.a", "reset-1", :reset, name)
    assert {:planned, _} = PlannedDisconnects.disconnect("agent.a", name)

    assert {:deferred, %{phase: :disconnected}} =
             PlannedDisconnects.fail("agent.a", "reset-1", :spawn_failed, name)

    assert :noop = PlannedDisconnects.fail("agent.a", "stale", :rollback_failed, name)
    assert PlannedDisconnects.active?("agent.a", name)

    assert {:reconnected, _} =
             PlannedDisconnects.confirm_connection("agent.a", "reset-1", name)

    assert :noop = PlannedDisconnects.fail("agent.a", "reset-1", :rollback_failed, name)

    assert :ok = PlannedDisconnects.begin("agent.a", "reset-2", :reset, name)

    assert {:failed, %{transition_id: "reset-2"}} =
             PlannedDisconnects.fail("agent.a", "reset-2", :rollback_failed, name)

    refute PlannedDisconnects.active?("agent.a", name)

    # `spawn_failed` defer is reset-specific. A future lifecycle producer
    # reusing that reason must not inherit rollback semantics accidentally.
    assert :ok = PlannedDisconnects.begin("agent.restart", "restart-1", :restart, name)

    assert {:failed, %{kind: :restart}} =
             PlannedDisconnects.fail("agent.restart", "restart-1", :spawn_failed, name)

    refute PlannedDisconnects.active?("agent.restart", name)
  end

  test "timeout consumes once and a matching join cancels its callback" do
    owner = self()
    callback = fn agent_id, transition_id -> send(owner, {:timeout, agent_id, transition_id}) end
    name = start_tracker(:pd_timeout, timeout_ms: 20, on_timeout: callback)

    assert :ok = PlannedDisconnects.begin("agent.timeout", "tr-timeout", :restart, name)
    assert_receive {:timeout, "agent.timeout", "tr-timeout"}, 100
    refute PlannedDisconnects.active?("agent.timeout", name)

    assert :ok = PlannedDisconnects.begin("agent.success", "tr-success", :restart, name)
    assert {:planned, _} = PlannedDisconnects.disconnect("agent.success", name)

    assert {:reconnected, _} =
             PlannedDisconnects.confirm_connection("agent.success", "tr-success", name)

    refute_receive {:timeout, "agent.success", "tr-success"}, 50
  end
end
