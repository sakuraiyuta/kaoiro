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

  test "intent は disconnect 前から notice_targets を宣言する" do
    name = start_tracker(:pd_declared_notice_targets)
    assert :ok = PlannedDisconnects.begin("pd.declared", "tr-declared", :restart, name)

    assert %PlannedDisconnects.Intent{notice_targets: nil} =
             :sys.get_state(name).pending["pd.declared"]

    assert %{notice_targets: nil} = PlannedDisconnects.get("pd.declared", name)

    assert {:planned, %{notice_targets: []}} =
             PlannedDisconnects.disconnect("pd.declared", name)
  end

  test "one intent per agent; disconnect snapshots bounded targets and only exact join consumes it" do
    owner = self()

    provider = fn agent_id, limit ->
      send(owner, {:provider, agent_id, limit})
      {[{"cid-1", ["peer.a"]}], 2}
    end

    name = start_tracker(:pd_state_machine, target_provider: provider)

    assert :ok = PlannedDisconnects.begin("agent.a", "tr-1", :switch_session, name)

    assert {:tracked, %{targets: [{"cid-bounce", ["peer.b"]}]}} =
             PlannedDisconnects.track_bounce("agent.a", "cid-bounce", "peer.b", name)

    # Repeated bounces are deduplicated before any close notice is emitted.
    assert {:tracked, %{targets: [{"cid-bounce", ["peer.b"]}]}} =
             PlannedDisconnects.track_bounce("agent.a", "cid-bounce", "peer.b", name)

    assert {:error, :agent_busy} =
             PlannedDisconnects.begin("agent.a", "tr-2", :restart, name)

    assert {:planned,
            %{
              phase: :disconnected,
              transition_id: "tr-1",
              kind: :switch_session,
              targets: [{"cid-1", ["peer.a"]}, {"cid-bounce", ["peer.b"]}],
              notice_targets: [{"cid-1", ["peer.a"]}],
              unclaimed: 2
            }} = PlannedDisconnects.disconnect("agent.a", name)

    assert_receive {:provider, "agent.a", 50}
    assert :noop = PlannedDisconnects.disconnect("agent.a", name)
    assert :mismatch = PlannedDisconnects.confirm_connection("agent.a", "stale", name)
    assert PlannedDisconnects.active?("agent.a", name)

    assert {:reconnected, %{targets: [{"cid-1", ["peer.a"]}, {"cid-bounce", ["peer.b"]}]}} =
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

    assert {:tracked, _} =
             PlannedDisconnects.track_bounce("agent.a", "cid-failed", "peer.failed", name)

    assert {:failed,
            %{
              transition_id: "reset-2",
              targets: [{"cid-failed", ["peer.failed"]}]
            }} =
             PlannedDisconnects.fail("agent.a", "reset-2", :rollback_failed, name)

    refute PlannedDisconnects.active?("agent.a", name)

    # `spawn_failed` defer is reset-specific. A future lifecycle producer
    # reusing that reason must not inherit rollback semantics accidentally.
    assert :ok = PlannedDisconnects.begin("agent.restart", "restart-1", :restart, name)

    assert {:failed, %{kind: :restart}} =
             PlannedDisconnects.fail("agent.restart", "restart-1", :spawn_failed, name)

    refute PlannedDisconnects.active?("agent.restart", name)
  end

  test "target admission caps synth-envelope pairs and preserves accepted close promises" do
    provider = fn _agent_id, _limit ->
      {[{"cid-overlap", ["peer.one"]}, {"cid-drop", ["peer.three"]}], 4}
    end

    name =
      start_tracker(:pd_target_capacity,
        target_provider: provider,
        max_targets: 2
      )

    assert :ok = PlannedDisconnects.begin("agent.cap", "tr-cap", :restart, name)

    assert {:tracked, %{targets: [{"cid-overlap", ["peer.one"]}]}} =
             PlannedDisconnects.track_bounce(
               "agent.cap",
               "cid-overlap",
               "peer.one",
               name
             )

    # The same promise is idempotent and consumes no second slot.
    assert {:tracked, %{targets: [{"cid-overlap", ["peer.one"]}]}} =
             PlannedDisconnects.track_bounce(
               "agent.cap",
               "cid-overlap",
               "peer.one",
               name
             )

    # Same cid but a different peer means a distinct synth envelope.
    assert {:tracked, %{targets: [{"cid-overlap", ["peer.one", "peer.two"]}]}} =
             PlannedDisconnects.track_bounce(
               "agent.cap",
               "cid-overlap",
               "peer.two",
               name
             )

    assert {:capacity, %{targets: [{"cid-overlap", ["peer.one", "peer.two"]}]}} =
             PlannedDisconnects.track_bounce(
               "agent.cap",
               "cid-overflow",
               "peer.overflow",
               name
             )

    assert {:planned,
            %{
              targets: [{"cid-overlap", ["peer.one", "peer.two"]}],
              notice_targets: [],
              dropped_targets: [{"cid-drop", ["peer.three"]}],
              unclaimed: 4
            }} = PlannedDisconnects.disconnect("agent.cap", name)
  end

  test "announced phase also accepts an exact non-empty join and consumes once" do
    name = start_tracker(:pd_announced_join)
    assert :ok = PlannedDisconnects.begin("agent.order", "tr-order", :restart, name)

    assert {:tracked, _} =
             PlannedDisconnects.track_bounce(
               "agent.order",
               "cid-order",
               "peer.order",
               name
             )

    assert :mismatch =
             PlannedDisconnects.confirm_connection("agent.order", "stale-order", name)

    assert {:reconnected, %{phase: :announced, targets: [{"cid-order", ["peer.order"]}]}} =
             PlannedDisconnects.confirm_connection("agent.order", "tr-order", name)

    refute PlannedDisconnects.active?("agent.order", name)
    assert :noop = PlannedDisconnects.confirm_connection("agent.order", "tr-order", name)
  end

  test "timeout consumes once and a matching join cancels its callback" do
    owner = self()

    callback = fn agent_id, transition_id, intent ->
      send(owner, {:timeout, agent_id, transition_id, intent})
    end

    name = start_tracker(:pd_timeout, timeout_ms: 20, on_timeout: callback)

    assert :ok = PlannedDisconnects.begin("agent.timeout", "tr-timeout", :restart, name)

    assert {:tracked, _} =
             PlannedDisconnects.track_bounce(
               "agent.timeout",
               "cid-timeout",
               "peer.timeout",
               name
             )

    assert_receive {:timeout, "agent.timeout", "tr-timeout",
                    %{targets: [{"cid-timeout", ["peer.timeout"]}]}},
                   100

    refute PlannedDisconnects.active?("agent.timeout", name)

    assert :ok = PlannedDisconnects.begin("agent.success", "tr-success", :restart, name)
    assert {:planned, _} = PlannedDisconnects.disconnect("agent.success", name)

    assert {:reconnected, _} =
             PlannedDisconnects.confirm_connection("agent.success", "tr-success", name)

    refute_receive {:timeout, "agent.success", "tr-success", _intent}, 50
  end

  test "every explicit cancel returns the same tracked target union and exact cancel is CAS" do
    name = start_tracker(:pd_cancel)

    assert :noop = PlannedDisconnects.track_bounce("agent.none", "cid", "peer", name)
    assert :ok = PlannedDisconnects.begin("agent.cancel", "tr-cancel", :restart, name)

    assert {:tracked, _} =
             PlannedDisconnects.track_bounce(
               "agent.cancel",
               "cid-cancel",
               "peer.cancel",
               name
             )

    assert :noop =
             PlannedDisconnects.cancel_transition("agent.cancel", "stale-transition", name)

    assert {:cancelled, %{targets: [{"cid-cancel", ["peer.cancel"]}]}} =
             PlannedDisconnects.cancel_transition("agent.cancel", "tr-cancel", name)

    assert :ok = PlannedDisconnects.begin("agent.stop", "tr-stop", :restart, name)

    assert {:tracked, _} =
             PlannedDisconnects.track_bounce("agent.stop", "cid-stop", "peer.stop", name)

    assert {:cancelled, %{targets: [{"cid-stop", ["peer.stop"]}]}} =
             PlannedDisconnects.cancel("agent.stop", name)

    assert :noop = PlannedDisconnects.cancel("agent.stop", name)
  end
end
