defmodule KaoiroServer.InterAgentQueuePolicyTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.InterAgentQueuePolicy, as: Policy

  @ceiling 8_388_608

  defp join(overrides \\ %{}, policy_overrides \\ %{}) do
    policy =
      Map.merge(
        %{"batch_max_items" => 10, "backlog_max_items" => 100, "backlog_max_bytes" => 524_288},
        policy_overrides
      )

    Map.merge(
      %{
        "inter_agent_queue" => "credit-v1",
        "inter_agent_queue_policy" => policy,
        "inter_agent_delivery_ack" => "dispatch-v1",
        "delivery_resync" => "skip-v1",
        "delivery_generation" => "generation"
      },
      overrides
    )
  end

  test "a wrapper that declares no queue is reported absent" do
    assert Policy.validate_join(%{"delivery_generation" => "generation"}, @ceiling) == :absent
  end

  test "a complete declaration binds the declared tuple without defaults" do
    assert {:ok, %{policy: policy, inline_recovery: false}} =
             Policy.validate_join(join(%{}, %{"batch_max_items" => 3}), @ceiling)

    assert policy == %{batch_max_items: 3, backlog_max_items: 100, backlog_max_bytes: 524_288}
  end

  test "the configured ceiling is the default bound" do
    assert Policy.backlog_max_bytes_ceiling() == @ceiling
  end

  describe "capability" do
    test "another queue version is refused" do
      assert {:error, %{reason: "queue_capability_required", missing: ["inter_agent_queue"]}} =
               Policy.validate_join(join(%{"inter_agent_queue" => "credit-v2"}), @ceiling)
    end

    test "every absent prerequisite is listed" do
      params =
        join()
        |> Map.drop(["inter_agent_delivery_ack", "delivery_resync"])
        |> Map.put("delivery_generation", "")

      assert {:error, %{reason: "queue_capability_required", missing: missing}} =
               Policy.validate_join(params, @ceiling)

      assert missing == ["inter_agent_delivery_ack", "delivery_resync", "delivery_generation"]
    end

    test "inline recovery is accepted only with the reply basis" do
      with_basis =
        join(%{"inter_agent_inline_recovery" => "v1", "inter_agent_reply_basis" => "v1"})

      assert {:ok, %{inline_recovery: true}} = Policy.validate_join(with_basis, @ceiling)

      assert {:error, %{missing: ["inter_agent_reply_basis"]}} =
               Policy.validate_join(join(%{"inter_agent_inline_recovery" => "v1"}), @ceiling)

      assert {:error, %{missing: ["inter_agent_inline_recovery"]}} =
               Policy.validate_join(
                 join(%{
                   "inter_agent_inline_recovery" => "v2",
                   "inter_agent_reply_basis" => "v1"
                 }),
                 @ceiling
               )
    end
  end

  describe "policy tuple" do
    test "a missing or non-object tuple is refused" do
      for policy <- [nil, "10,100,524288", [10, 100, 524_288]] do
        params = Map.put(join(), "inter_agent_queue_policy", policy)

        assert {:error,
                %{
                  reason: "invalid_queue_policy",
                  field: "inter_agent_queue_policy",
                  detail: "missing"
                }} = Policy.validate_join(params, @ceiling)
      end

      assert {:error, %{field: "inter_agent_queue_policy", detail: "missing"}} =
               Policy.validate_join(Map.delete(join(), "inter_agent_queue_policy"), @ceiling)
    end

    test "a partial tuple is refused rather than defaulted" do
      for field <- ~w(batch_max_items backlog_max_items backlog_max_bytes) do
        params = update_in(join()["inter_agent_queue_policy"], &Map.delete(&1, field))

        assert Policy.validate_join(params, @ceiling) ==
                 {:error, %{reason: "invalid_queue_policy", field: field, detail: "missing"}}
      end
    end

    test "a non-integer value is refused" do
      for value <- [10.0, "10", true, nil] do
        assert {:error, %{field: "batch_max_items", detail: "not_integer"}} =
                 Policy.validate_join(join(%{}, %{"batch_max_items" => value}), @ceiling)
      end
    end

    test "each lower bound is inclusive" do
      assert {:ok, _} =
               Policy.validate_join(
                 join(%{}, %{
                   "batch_max_items" => 1,
                   "backlog_max_items" => 1,
                   "backlog_max_bytes" => 16_384
                 }),
                 @ceiling
               )

      for {field, value, limit} <- [
            {"batch_max_items", 0, 1},
            {"backlog_max_items", 0, 1},
            {"backlog_max_bytes", 16_383, 16_384}
          ] do
        assert Policy.validate_join(join(%{}, %{field => value}), @ceiling) ==
                 {:error,
                  %{
                    reason: "invalid_queue_policy",
                    field: field,
                    detail: "below_minimum",
                    limit: limit
                  }}
      end
    end

    test "backlog_max_items is capped at 1000" do
      assert {:ok, _} = Policy.validate_join(join(%{}, %{"backlog_max_items" => 1000}), @ceiling)

      assert Policy.validate_join(join(%{}, %{"backlog_max_items" => 1001}), @ceiling) ==
               {:error,
                %{
                  reason: "invalid_queue_policy",
                  field: "backlog_max_items",
                  detail: "above_ceiling",
                  limit: 1000
                }}
    end

    test "backlog_max_bytes is capped at the given ceiling" do
      assert {:ok, _} = Policy.validate_join(join(%{}, %{"backlog_max_bytes" => 20_000}), 20_000)

      assert Policy.validate_join(join(%{}, %{"backlog_max_bytes" => 20_001}), 20_000) ==
               {:error,
                %{
                  reason: "invalid_queue_policy",
                  field: "backlog_max_bytes",
                  detail: "above_ceiling",
                  limit: 20_000
                }}
    end
  end
end
