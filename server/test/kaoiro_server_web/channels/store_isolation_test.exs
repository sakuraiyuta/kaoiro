defmodule KaoiroServerWeb.StoreIsolationTest do
  # Reused-identity fixture (issue 554). Both tests use the same identities and
  # write one row into every store that KaoiroServer.TestStores resets. Whichever
  # test runs second must start with none of those rows. Removing one reset step,
  # or moving a seed-dependent store before its seed, must turn the second test
  # red.
  use KaoiroServerWeb.ChannelCase, async: false

  alias KaoiroServer.{
    AgentActivity,
    AgentDirectory,
    ClearWatermarks,
    ConversationStates,
    DeliveryStates,
    IngressOrder,
    PermissionModes,
    PermissionSettings,
    QuagmireSettings,
    SessionLifecycleEvents,
    SessionPointers,
    SessionStarts,
    AgentStatusLines,
    TokenDenylist,
    Users,
    WorkStore,
    WrapperBuildInfos
  }

  @agent "iso.reused-agent"
  @conversation "iso-reused-conversation"
  @at "2026-08-01T00:00:00Z"
  @principal %{"kind" => "user", "id" => "iso-operator"}
  # WorkStore accepts only op_<millis>_<22 base64 chars>, with millis inside its
  # validity window. The module is compiled at the start of the run, so the
  # timestamp is current for both test lifetimes.
  @operation_id "op_#{System.system_time(:millisecond)}_#{String.duplicate("A", 22)}"
  # Planted as the top of IngressOrder's seed sources. A store that restarts
  # before its seeds are reset would seed from this and show it.
  @seed_us 9_999_999_999_999_999
  @seed_seq 9_999_999
  @seed {@seed_us, @seed_seq}

  defp assert_clean! do
    assert SessionLifecycleEvents.list_for_agent(@agent) == []
    assert DeliveryStates.get(@agent) == nil
    assert AgentActivity.get(@agent) == nil
    assert ConversationStates.get(@conversation) == nil
    assert SessionPointers.get(@agent) == nil
    assert AgentDirectory.get(@agent) == nil
    assert PermissionModes.get(@agent) == nil
    assert PermissionSettings.get(@agent) == nil
    refute match?({:ok, _}, WorkStore.op_result(@principal, @operation_id))
    assert QuagmireSettings.rally_turns() != 97
    refute Enum.any?(Map.values(Users.all()), &(Map.get(&1, :display_name) == "Iso"))
    refute Map.has_key?(WrapperBuildInfos.snapshot(), @agent)
    refute TokenDenylist.revoked?(@agent)
    assert AgentStatusLines.history(@agent) == {:ok, []}
    assert ClearWatermarks.get(@agent) == nil
    assert SessionStarts.get(@agent) == nil
    assert IngressOrder.peek() < @seed
  end

  # Each write must be visible before the test ends, or the fixture proves
  # nothing about the reset.
  defp write_rows! do
    assert :ok =
             ConversationStates.record_message(
               @conversation,
               @agent,
               "iso.peer",
               "hi",
               1,
               false,
               true
             )

    envelope = %{"agent_id" => @agent, "type" => "state_change", "state" => "idle", "ts" => @at}
    :ok = AgentActivity.record_envelope(envelope, self(), @at)
    SessionLifecycleEvents.append(@agent, "compacting", nil, @at)
    _ = DeliveryStates.bind(@agent, "iso-gen")
    _ = DeliveryStates.issue(@agent)
    :ok = SessionPointers.record(@agent, "iso-session", "/tmp/iso", "claude-code")
    :ok = AgentDirectory.record(@agent, "iso-persona", "Iso")
    :ok = PermissionModes.record(@agent, "default")
    _ = PermissionSettings.record_observation(@agent, "codex", permission_control())
    assert {:ok, _} = WorkStore.apply(@principal, work_operation(), %{operator: true})
    :ok = QuagmireSettings.put_rally_turns(97)
    {:ok, _user} = Users.get_or_create("github", "operator", "Iso")

    :ok =
      WrapperBuildInfos.put(
        @agent,
        %{
          "build_revision" => String.duplicate("a", 40),
          "build_dirty" => false,
          "build_version" => "2026.9.0",
          "build_channel" => "dev"
        },
        self()
      )

    :ok = TokenDenylist.revoke(@agent, nil)
    {:ok, _} = AgentStatusLines.put(@agent, "iso line")
    :ok = ClearWatermarks.record(@agent, @seed, "2026-08-01T00:00:00Z")
    _ = SessionStarts.advance_transition(@agent, nil)
    _ = SessionStarts.adopt_sid(@agent, "iso-sid")
    _ = IngressOrder.allocate()

    assert SessionLifecycleEvents.list_for_agent(@agent) != []
    assert DeliveryStates.get(@agent) != nil
    assert AgentActivity.get(@agent) != nil
    assert ConversationStates.get(@conversation) != nil
    assert SessionPointers.get(@agent) != nil
    assert AgentDirectory.get(@agent) != nil
    assert PermissionModes.get(@agent) != nil
    assert {:ok, _} = WorkStore.op_result(@principal, @operation_id)
    assert QuagmireSettings.rally_turns() == 97
    assert Map.has_key?(WrapperBuildInfos.snapshot(), @agent)
    assert TokenDenylist.revoked?(@agent)
    assert ClearWatermarks.get(@agent) != nil
    assert SessionStarts.get(@agent) != nil
  end

  # A pending baseline is stored, but record_observation/4 reports it as
  # :not_confirmed because only an applied observation counts as confirmed.
  defp permission_control do
    %{
      "revision" => 0,
      "requested" => %{"sandbox" => "read-only", "network_access" => false},
      "status" => "pending",
      "constraints" => %{"approval" => "never", "enforcement" => "os"}
    }
  end

  defp work_operation do
    %{
      "op" => "assign",
      "operation_id" => @operation_id,
      "title" => "iso",
      "assignee" => "iso.agent",
      "director" => @principal,
      "requires_verdict" => false
    }
  end

  test "the clean checker handles an empty Users registry" do
    KaoiroServer.TestStores.reset!()
    assert Users.all() == %{}
    assert_clean!()
  end

  test "the clean checker handles users other than the leaked identity" do
    assert {:ok, _} = Users.get_or_create("fixture-non-iso", "operator", "Another")
    assert map_size(Users.all()) > 0
    assert_clean!()
  end

  test "the clean checker rejects the leaked user in a nonempty registry" do
    assert {:ok, _} = Users.get_or_create("fixture-iso", "operator", "Iso")
    assert_raise ExUnit.AssertionError, fn -> assert_clean!() end
  end

  describe "the same identities in two test lifetimes" do
    test "the first lifetime starts clean and writes rows" do
      assert_clean!()
      write_rows!()
    end

    test "the second lifetime starts clean and writes rows" do
      assert_clean!()
      write_rows!()
    end
  end
end
