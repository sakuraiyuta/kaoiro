defmodule KaoiroServer.InterAgentReplyBasisTest do
  use ExUnit.Case, async: true
  alias KaoiroServer.InterAgentReplyBasis
  @fixtures Path.expand("../../../protocol/fixtures/inter-agent-internal-notices.json", __DIR__)
  test "protocol fixtures define the entire internal notification exception" do
    for fixture <- Jason.decode!(File.read!(@fixtures)) do
      code = fixture["code"]
      message = fixture["message"]
      error = Map.take(fixture, ~w(code message reset_delay_seconds))

      notice = %{
        "to" => "b",
        "conversation_id" => "cid",
        "turn_number" => 2,
        "new_conversation" => false,
        "kind" => "inform",
        "meta" => %{"done" => false, "propose_next" => ""},
        "error" => error,
        "body" => "peer error (#{code}): #{message}",
        "notice_type" => fixture["notice_type"]
      }

      assert {:ok, :notice} = InterAgentReplyBasis.admission(notice, true)
      assert {:error, :invalid_internal_notice} = InterAgentReplyBasis.admission(notice, false)

      assert {:ok, :legacy} =
               InterAgentReplyBasis.admission(Map.delete(notice, "notice_type"), false)

      for {field, value} <- [
            {"extra", "verdict"},
            {"in_reply_to", 1},
            {"new_conversation", true},
            {"kind", "done"},
            {"meta", %{"done" => true, "propose_next" => ""}},
            {"body", "approve"},
            {"notice_type", "unknown"}
          ] do
        assert {:error, :invalid_internal_notice} =
                 InterAgentReplyBasis.admission(Map.put(notice, field, value), true)
      end
    end
  end

  test "only safe nonnegative integers can be ordinary protected bases" do
    for basis <- [nil, -1, 0.5, "1", 9_007_199_254_740_992] do
      assert {:error, :invalid_reply_basis} =
               InterAgentReplyBasis.admission(%{"in_reply_to" => basis}, true)
    end

    assert {:ok, 0} = InterAgentReplyBasis.admission(%{"in_reply_to" => 0}, true)
    assert {:ok, :legacy} = InterAgentReplyBasis.admission(%{}, false)
  end

  test "scoped turn-failure notices require exact, ordered, bounded coverage" do
    message = "the peer's turn timed out"

    notice = %{
      "to" => "sender",
      "conversation_id" => "cid",
      "turn_number" => 3,
      "new_conversation" => false,
      "kind" => "inform",
      "meta" => %{"done" => false, "propose_next" => ""},
      "notice_type" => "turn_failure",
      "error" => %{
        "code" => "timeout",
        "message" => message,
        "affected_deliveries" => [
          %{"delivery_seq" => 1, "peer_turn_number" => 2, "batch_id" => "steer-a"},
          %{"delivery_seq" => 4, "peer_turn_number" => 5, "batch_id" => "steer-b"}
        ]
      },
      "body" => "peer error (timeout): #{message}"
    }

    assert {:ok, :notice} = InterAgentReplyBasis.admission(notice, true)

    for invalid <- [
          [],
          List.duplicate(hd(notice["error"]["affected_deliveries"]), 17),
          Enum.reverse(notice["error"]["affected_deliveries"]),
          [
            hd(notice["error"]["affected_deliveries"]),
            hd(notice["error"]["affected_deliveries"])
          ],
          [%{"delivery_seq" => 0, "peer_turn_number" => 2, "batch_id" => "steer-a"}],
          [%{"delivery_seq" => 1, "peer_turn_number" => 0, "batch_id" => "steer-a"}],
          [%{"delivery_seq" => 1, "peer_turn_number" => 2, "batch_id" => ""}],
          [Map.put(hd(notice["error"]["affected_deliveries"]), "extra", true)]
        ] do
      changed = put_in(notice, ["error", "affected_deliveries"], invalid)

      assert InterAgentReplyBasis.admission(changed, true) ==
               {:error, :invalid_internal_notice},
             "accepted invalid coverage: #{inspect(invalid)}"
    end

    stale = %{notice | "notice_type" => "stale_delivery"}
    assert {:error, :invalid_internal_notice} = InterAgentReplyBasis.admission(stale, true)

    assert {:error, :invalid_internal_notice} =
             InterAgentReplyBasis.admission(put_in(notice, ["error", "unknown"], true), true)
  end
end
