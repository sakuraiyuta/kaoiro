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

  test "receiver overload notice accepts the exact fixed wrapper template and rejects altered attribution" do
    message = "peer input backlog is full; this message was not submitted to the model"

    notice = %{
      "to" => "sender",
      "conversation_id" => "cid",
      "turn_number" => 4,
      "new_conversation" => false,
      "kind" => "inform",
      "meta" => %{"done" => false, "propose_next" => ""},
      "notice_type" => "turn_failure",
      "error" => %{
        "code" => "receiver_overloaded",
        "message" => message,
        "affected_deliveries" => [
          %{"delivery_seq" => 5, "peer_turn_number" => 7, "batch_id" => "attempt-1"}
        ]
      },
      "body" => "peer error (receiver_overloaded): #{message}"
    }

    assert {:ok, :notice} = InterAgentReplyBasis.admission(notice, true)

    for changed <- [
          put_in(notice, ["error", "message"], "other"),
          Map.put(notice, "body", "other"),
          put_in(notice, ["error", "affected_deliveries", Access.at(0), "peer_turn_number"], 0),
          put_in(notice, ["error", "affected_deliveries", Access.at(0), "batch_id"], "")
        ] do
      assert {:error, :invalid_internal_notice} = InterAgentReplyBasis.admission(changed, true)
    end
  end

  test "current built InterAgentTool overload notice passes the server validator" do
    payload_path = System.fetch_env!("KAOIRO_ISSUE_214_BUILDER_PAYLOAD")
    manifest_path = System.fetch_env!("KAOIRO_ISSUE_214_BUILDER_MANIFEST")
    expected_revision = System.fetch_env!("KAOIRO_ISSUE_214_EXPECTED_GIT_REVISION")
    root = Path.expand("../../..", __DIR__)
    payload_bytes = File.read!(payload_path)
    manifest = manifest_path |> File.read!() |> Jason.decode!()
    builder_source = File.read!(Path.join(root, manifest["builder_source_path"]))
    builder_build = File.read!(Path.join(root, manifest["builder_build_path"]))
    hash = fn bytes -> :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower) end
    envelopes = Jason.decode!(payload_bytes)
    notices = Enum.map(envelopes, & &1["payload"])

    assert manifest["git_revision"] == expected_revision
    assert manifest["payload_path"] == Path.basename(payload_path)
    assert manifest["payload_sha256"] == hash.(payload_bytes)
    assert manifest["builder_source_sha256"] == hash.(builder_source)
    assert manifest["builder_build_sha256"] == hash.(builder_build)
    assert length(notices) == 2

    for notice <- notices do
      assert {:ok, :notice} = InterAgentReplyBasis.admission(notice, true)

      invalid_notices = [
        put_in(notice, ["error", "code"], "other"),
        put_in(notice, ["error", "message"], "other"),
        put_in(notice, ["body"], "other"),
        put_in(notice, ["error", "affected_deliveries", Access.at(0), "delivery_seq"], 0),
        put_in(notice, ["error", "affected_deliveries", Access.at(0), "peer_turn_number"], 0),
        put_in(notice, ["error", "affected_deliveries", Access.at(0), "batch_id"], ""),
        put_in(notice, ["notice_type"], "unknown"),
        Map.put(notice, "in_reply_to", 0),
        Map.put(notice, "unexpected", true)
      ]

      for changed <- invalid_notices do
        assert {:error, :invalid_internal_notice} =
                 InterAgentReplyBasis.admission(changed, true)
      end
    end
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
