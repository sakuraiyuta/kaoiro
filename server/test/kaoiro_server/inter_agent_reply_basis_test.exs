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
end
