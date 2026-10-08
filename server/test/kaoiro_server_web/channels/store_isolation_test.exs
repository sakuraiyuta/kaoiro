defmodule KaoiroServerWeb.StoreIsolationTest do
  # Reused-identity fixture (issue 554). Both tests use the same identities.
  # Whichever runs second must start with no rows in any of the four stores.
  # Removing one reset step in KaoiroServer.TestStores.reset!/0 must turn the
  # second test red.
  use KaoiroServerWeb.ChannelCase, async: false

  alias KaoiroServer.{AgentActivity, ConversationStates, DeliveryStates, SessionLifecycleEvents}

  @agent "iso.reused-agent"
  @conversation "iso-reused-conversation"
  @at "2026-08-01T00:00:00Z"

  defp assert_clean! do
    assert SessionLifecycleEvents.list_for_agent(@agent) == []
    assert :dets.lookup(SessionLifecycleEvents, @agent) == []
    assert DeliveryStates.get(@agent) == nil
    assert :dets.lookup(DeliveryStates, @agent) == []
    assert AgentActivity.get(@agent) == nil
    assert ConversationStates.get(@conversation) == nil
  end

  # Each write must be visible before the test ends, or the fixture proves
  # nothing about the reset.
  defp write_rows! do
    SessionLifecycleEvents.append(@agent, "compacting", nil, @at)
    _ = DeliveryStates.bind(@agent, "iso-gen")
    _ = DeliveryStates.issue(@agent)
    envelope = %{"agent_id" => @agent, "type" => "state_change", "state" => "idle", "ts" => @at}
    :ok = AgentActivity.record_envelope(envelope, self(), @at)

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

    assert SessionLifecycleEvents.list_for_agent(@agent) != []
    assert DeliveryStates.get(@agent) != nil
    assert AgentActivity.get(@agent) != nil
    assert ConversationStates.get(@conversation) != nil
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
