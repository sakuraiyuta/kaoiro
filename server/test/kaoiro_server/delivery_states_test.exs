defmodule KaoiroServer.DeliveryStatesTest do
  use ExUnit.Case, async: false

  import KaoiroServer.TestTeardown

  alias KaoiroServer.DeliveryStates

  setup do
    name = :"delivery_states_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
    File.rm(path)
    {:ok, _} = DeliveryStates.start_link(name: name, path: path)

    on_exit(fn ->
      stop_quietly(name)
      File.rm(path)
    end)

    %{name: name, path: path}
  end

  @tag :r1_fix
  test "M5 simultaneous early reservations share the recipient cap", %{name: name} do
    DeliveryStates.bind_resync("early-recipient", "generation", self(), name)
    parent = self()

    tasks =
      for index <- 1..17 do
        Task.async(fn ->
          sender = "sender-#{index}"
          {:ok, token} = DeliveryStates.reserve("early-recipient", self(), name)
          result = DeliveryStates.reserve_early(sender, "early-recipient", token, 4, 16, name)
          send(parent, {:early_reserved, sender, result})

          receive do
            :release -> DeliveryStates.release(token, name)
          end
        end)
      end

    results =
      for _ <- tasks do
        assert_receive {:early_reserved, _sender, result}
        result
      end

    assert Enum.count(results, &(&1 == :ok)) == 16
    assert Enum.count(results, &(&1 == {:error, :early_quota})) == 1
    assert {0, 16} = DeliveryStates.pending_early("other-sender", "early-recipient", name)
    for task <- tasks, do: send(task.pid, :release)
    for task <- tasks, do: assert(:ok = Task.await(task))
    assert {0, 0} = DeliveryStates.pending_early("other-sender", "early-recipient", name)
  end

  @tag :r2_fix
  test "M5 dispatch acknowledgement retains early pair slots until stage or generation", %{
    name: name,
    path: path
  } do
    recipient = "early-ack-recipient"
    sender = "early-ack-sender"
    owner = self()
    DeliveryStates.bind_resync(recipient, "generation", owner, name)
    incarnation = DeliveryStates.incarnation(recipient, name)

    for seq <- 1..4 do
      assert {:ok, token} = DeliveryStates.reserve(recipient, owner, name)
      assert :ok = DeliveryStates.reserve_early(sender, recipient, token, 4, 16, name)

      assert ^seq =
               DeliveryStates.issue_reserved(
                 recipient,
                 token,
                 %{sender: sender, conversation_id: "early-ack", turn_number: seq, mode: "early"},
                 name
               )
    end

    assert {4, 4} = DeliveryStates.pending_early(sender, recipient, name)
    assert %{acked_seq: 4} = DeliveryStates.acknowledge(recipient, "generation", owner, 4, name)

    assert {:ok, %{stages: %{"accepted" => _}}} =
             DeliveryStates.message_status(sender, "early-ack", 4, name)

    [{^recipient, _, _, _, _, %{early_pending: persisted}}] = :dets.lookup(name, recipient)
    assert map_size(persisted) == 4
    assert {4, 4} = DeliveryStates.pending_early(sender, recipient, name)
    assert {:ok, fifth} = DeliveryStates.reserve(recipient, owner, name)

    assert {:error, :early_quota} =
             DeliveryStates.reserve_early(sender, recipient, fifth, 4, 16, name)

    assert :ok = DeliveryStates.release(fifth, name)

    GenServer.stop(Process.whereis(name))
    {:ok, _} = DeliveryStates.start_link(name: name, path: path)
    DeliveryStates.bind_resync(recipient, "generation", owner, name)
    assert {4, 4} = DeliveryStates.pending_early(sender, recipient, name)

    GenServer.stop(Process.whereis(name))
    {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))

    [{^recipient, generation, issued, acked, pending_since, recovery}] =
      :dets.lookup(name, recipient)

    :ok =
      :dets.insert(
        name,
        {recipient, generation, issued, acked, pending_since,
         Map.delete(recovery, :early_pending)}
      )

    :ok = :dets.sync(name)
    :ok = :dets.close(name)
    {:ok, _} = DeliveryStates.start_link(name: name, path: path)
    DeliveryStates.bind_resync(recipient, "generation", owner, name)
    assert {4, 4} = DeliveryStates.pending_early(sender, recipient, name)

    for {seq, stage, remaining} <- [{1, "submitted", 3}, {2, "settled", 2}, {3, "unknown", 1}] do
      report = %{
        "incarnation" => incarnation,
        "generation" => "generation",
        "delivery_seq" => seq,
        "stage" => stage,
        "at" => DateTime.utc_now() |> DateTime.to_iso8601()
      }

      report =
        if stage == "submitted", do: Map.put(report, "handoff", "prompt_hook"), else: report

      assert :ok = DeliveryStates.report_stage(recipient, "generation", owner, report, name)
      assert {^remaining, ^remaining} = DeliveryStates.pending_early(sender, recipient, name)
    end

    DeliveryStates.bind(recipient, "new-generation", name)
    assert {0, 0} = DeliveryStates.pending_early(sender, recipient, name)
    DeliveryStates.bind_resync(recipient, "new-generation", owner, name)
    assert {0, 0} = DeliveryStates.pending_early(sender, recipient, name)
  end

  @tag :r2_fix
  test "M5 dispatch acknowledgement retains the recipient cap and loss releases it", %{name: name} do
    recipient = "early-recipient-ack"
    owner = self()
    DeliveryStates.bind_resync(recipient, "generation", owner, name)

    for seq <- 1..16 do
      sender = "sender-#{seq}"
      assert {:ok, token} = DeliveryStates.reserve(recipient, owner, name)
      assert :ok = DeliveryStates.reserve_early(sender, recipient, token, 4, 16, name)

      assert ^seq =
               DeliveryStates.issue_reserved(
                 recipient,
                 token,
                 %{
                   sender: sender,
                   conversation_id: "early-recipient",
                   turn_number: seq,
                   mode: "early"
                 },
                 name
               )
    end

    assert %{acked_seq: 16} = DeliveryStates.acknowledge(recipient, "generation", owner, 16, name)
    assert {0, 16} = DeliveryStates.pending_early("seventeenth", recipient, name)
    assert {:ok, token} = DeliveryStates.reserve(recipient, owner, name)

    assert {:error, :early_quota} =
             DeliveryStates.reserve_early("seventeenth", recipient, token, 4, 16, name)

    assert :ok = DeliveryStates.release(token, name)

    assert :ok =
             DeliveryStates.report_stage(
               recipient,
               "generation",
               owner,
               %{
                 "incarnation" => DeliveryStates.incarnation(recipient, name),
                 "generation" => "generation",
                 "delivery_seq" => 1,
                 "stage" => "unknown",
                 "at" => DateTime.utc_now() |> DateTime.to_iso8601()
               },
               name
             )

    assert {0, 15} = DeliveryStates.pending_early("seventeenth", recipient, name)
    assert {:ok, token} = DeliveryStates.reserve(recipient, owner, name)
    assert :ok = DeliveryStates.reserve_early("seventeenth", recipient, token, 4, 16, name)

    assert 17 =
             DeliveryStates.issue_reserved(
               recipient,
               token,
               %{
                 sender: "seventeenth",
                 conversation_id: "early-recipient",
                 turn_number: 17,
                 mode: "early"
               },
               name
             )

    assert {1, 16} = DeliveryStates.pending_early("seventeenth", recipient, name)
    assert {:ok, _} = DeliveryStates.resync(recipient, "generation", owner, 17, [[17, 17]], name)
    assert {0, 15} = DeliveryStates.pending_early("seventeenth", recipient, name)
    DeliveryStates.bind_resync(recipient, "new-generation", owner, name)
    assert {0, 0} = DeliveryStates.pending_early("seventeenth", recipient, name)
  end

  @tag :r1_fix
  test "S1 non-prefix resolution is excluded from the unresolved count", %{name: name} do
    owner = self()
    DeliveryStates.bind_resync("count-recipient", "generation", owner, name)

    for seq <- 1..2 do
      assert ^seq =
               DeliveryStates.issue_synthetic(
                 "count-recipient",
                 %{sender: "sender", conversation_id: "count-cid", turn_number: seq},
                 name
               )
    end

    assert 2 = DeliveryStates.unresolved_count("count-recipient", name)

    assert :ok =
             DeliveryStates.report_stage(
               "count-recipient",
               "generation",
               owner,
               %{
                 "incarnation" => DeliveryStates.incarnation("count-recipient", name),
                 "generation" => "generation",
                 "delivery_seq" => 2,
                 "stage" => "submitted",
                 "handoff" => "prompt_hook",
                 "at" => DateTime.utc_now() |> DateTime.to_iso8601()
               },
               name
             )

    assert %{acked_seq: 0, issued_seq: 2} = DeliveryStates.get("count-recipient", name)
    assert 1 = DeliveryStates.unresolved_count("count-recipient", name)
  end

  test "submitted later sequence closes without crossing an earlier gap", %{
    name: name,
    path: path
  } do
    owner = self()
    DeliveryStates.bind_resync("recipient", "generation", owner, name)
    internal = :sys.get_state(name).entries["recipient"]

    for turn <- 1..2 do
      assert ^turn =
               DeliveryStates.issue_synthetic(
                 "recipient",
                 %{sender: "sender", conversation_id: "cid", turn_number: turn},
                 name
               )
    end

    report = %{
      "incarnation" => internal.incarnation,
      "generation" => "generation",
      "delivery_seq" => 2,
      "stage" => "submitted",
      "handoff" => "prompt_hook",
      "at" => DateTime.utc_now() |> DateTime.to_iso8601()
    }

    assert :ok = DeliveryStates.report_stage("recipient", "generation", owner, report, name)
    assert %{acked_seq: 0} = DeliveryStates.get("recipient", name)

    assert {:ok, %{stages: %{"submitted" => _}}} =
             DeliveryStates.message_status("sender", "cid", 2, name)

    GenServer.stop(Process.whereis(name))
    {:ok, _} = DeliveryStates.start_link(name: name, path: path)
    DeliveryStates.bind_resync("recipient", "generation", owner, name)
    assert %{acked_seq: 2} = DeliveryStates.acknowledge("recipient", "generation", owner, 1, name)

    assert {:ok, %{stages: %{"submitted" => _}}} =
             DeliveryStates.message_status("sender", "cid", 2, name)
  end

  test "submitted accepts the turn_start_accepted handoff and rejects an unknown one", %{
    name: name
  } do
    owner = self()
    DeliveryStates.bind_resync("recipient", "generation", owner, name)
    incarnation = DeliveryStates.incarnation("recipient", name)

    assert 1 =
             DeliveryStates.issue_synthetic(
               "recipient",
               %{sender: "sender", conversation_id: "cid", turn_number: 1},
               name
             )

    report = %{
      "incarnation" => incarnation,
      "generation" => "generation",
      "delivery_seq" => 1,
      "stage" => "submitted",
      "at" => DateTime.utc_now() |> DateTime.to_iso8601()
    }

    assert {:error, :invalid_delivery_stage} =
             DeliveryStates.report_stage(
               "recipient",
               "generation",
               owner,
               Map.put(report, "handoff", "app_server_unknown"),
               name
             )

    assert :ok =
             DeliveryStates.report_stage(
               "recipient",
               "generation",
               owner,
               Map.put(report, "handoff", "turn_start_accepted"),
               name
             )

    assert {:ok, %{stages: %{"submitted" => _}}} =
             DeliveryStates.message_status("sender", "cid", 1, name)
  end

  test "V30j submission persists history and resolution in one recipient object", %{
    name: name,
    path: path
  } do
    owner = self()
    DeliveryStates.bind_resync("recipient", "generation", owner, name)
    incarnation = DeliveryStates.incarnation("recipient", name)

    for turn <- 1..2 do
      assert ^turn =
               DeliveryStates.issue_synthetic(
                 "recipient",
                 %{sender: "sender", conversation_id: "joint-stage-cid", turn_number: turn},
                 name
               )
    end

    table = :sys.get_state(name).table
    assert [{"recipient", _, _, _, _, before}] = :dets.lookup(table, "recipient")
    assert before.resolved == []

    refute Map.has_key?(
             before.stage_history[{"recipient", incarnation}][2].stages,
             "submitted"
           )

    assert :ok =
             DeliveryStates.report_stage(
               "recipient",
               "generation",
               owner,
               %{
                 "incarnation" => incarnation,
                 "generation" => "generation",
                 "delivery_seq" => 2,
                 "stage" => "submitted",
                 "handoff" => "prompt_hook",
                 "at" => DateTime.utc_now() |> DateTime.to_iso8601()
               },
               name
             )

    assert [{"recipient", _, _, _, _, persisted}] = :dets.lookup(table, "recipient")
    assert persisted.resolved == [2]
    assert persisted.metadata[2] == nil
    assert persisted.stage_history[{"recipient", incarnation}][2].stages["submitted"]
    assert [] = :dets.lookup(table, {:stage, {"recipient", incarnation}})

    GenServer.stop(name)
    {:ok, _} = DeliveryStates.start_link(name: name, path: path)
    DeliveryStates.bind_resync("recipient", "generation", owner, name)

    assert {:ok, %{acked_seq: 2, lost_count: 1}} =
             DeliveryStates.resync("recipient", "generation", owner, 2, [[1, 2]], name)

    assert {:ok, %{stages: %{"submitted" => _}}} =
             DeliveryStates.message_status("sender", "joint-stage-cid", 2, name)
  end

  test "V30j stage commit calls DETS with one recipient object", %{name: name} do
    owner = self()
    DeliveryStates.bind_resync("recipient", "generation", owner, name)
    incarnation = DeliveryStates.incarnation("recipient", name)

    assert 1 =
             DeliveryStates.issue_synthetic(
               "recipient",
               %{sender: "sender", conversation_id: "single-insert-cid", turn_number: 1},
               name
             )

    report = %{
      "incarnation" => incarnation,
      "generation" => "generation",
      "delivery_seq" => 1,
      "stage" => "submitted",
      "handoff" => "prompt_hook",
      "at" => DateTime.utc_now() |> DateTime.to_iso8601()
    }

    parent = self()

    tracer =
      spawn(fn ->
        receive do
          event -> send(parent, {:dets_trace, event})
        end
      end)

    pid = Process.whereis(name)
    :erlang.trace_pattern({:dets, :insert, 2}, true, [])
    :erlang.trace(pid, true, [:call, {:tracer, tracer}])

    try do
      assert :ok = DeliveryStates.report_stage("recipient", "generation", owner, report, name)
      assert_receive {:dets_trace, {:trace, ^pid, :call, {:dets, :insert, [^name, object]}}}
      refute is_list(object)
      assert elem(object, 0) == "recipient"
    after
      :erlang.trace(pid, false, [:call])
      :erlang.trace_pattern({:dets, :insert, 2}, false, [])
    end
  end

  test "stage history never enters public delivery projections", %{name: name} do
    DeliveryStates.bind_resync("recipient", "generation", self(), name)

    assert 1 =
             DeliveryStates.issue_synthetic(
               "recipient",
               %{sender: "sender", conversation_id: "private-stage-cid", turn_number: 1},
               name
             )

    assert is_map(:sys.get_state(name).entries["recipient"].stage_history)

    for projection <- [
          DeliveryStates.get("recipient", name),
          DeliveryStates.all(name)["recipient"]
        ] do
      refute Map.has_key?(projection, :stage_history)
      refute Map.has_key?(projection, "stage_history")
    end

    {wire, false} = DeliveryStates.wire_projection(DeliveryStates.all(name), MapSet.new())
    refute Map.has_key?(wire["recipient"], :stage_history)
  end

  test "history remains bounded across generations without changing the ledger", %{name: name} do
    previous = Application.fetch_env!(:kaoiro_server, :delivery_intent)

    Application.put_env(
      :kaoiro_server,
      :delivery_intent,
      Keyword.put(previous, :delivery_stage_max_records, 2)
    )

    on_exit(fn -> Application.put_env(:kaoiro_server, :delivery_intent, previous) end)
    owner = self()
    DeliveryStates.bind_resync("recipient", "generation-one", owner, name)

    for turn <- 1..2 do
      assert ^turn =
               DeliveryStates.issue_synthetic(
                 "recipient",
                 %{sender: "sender", conversation_id: "history-cap-cid", turn_number: turn},
                 name
               )

      assert %{acked_seq: ^turn} =
               DeliveryStates.acknowledge("recipient", "generation-one", owner, turn, name)

      Process.sleep(2)
    end

    DeliveryStates.bind_resync("recipient", "generation-two", owner, name)

    assert 3 =
             DeliveryStates.issue_synthetic(
               "recipient",
               %{sender: "sender", conversation_id: "history-cap-cid", turn_number: 3},
               name
             )

    assert {:ok, %{status: "expired"}} =
             DeliveryStates.message_status("sender", "history-cap-cid", 1, name)

    assert {:ok, %{stages: %{"accepted" => _}}} =
             DeliveryStates.message_status("sender", "history-cap-cid", 2, name)

    entry = :sys.get_state(name).entries["recipient"]
    assert entry.issued_seq == 3
    assert map_size(entry.metadata) == 1
    assert entry.resolved == []
    assert entry.stage_history |> Map.values() |> Enum.map(&map_size/1) |> Enum.sum() == 2
  end

  test "V33 incarnation mismatch is stale and does not change stage history", %{name: name} do
    owner = self()
    DeliveryStates.bind_resync("recipient", "generation", owner, name)
    incarnation = DeliveryStates.incarnation("recipient", name)
    assert is_binary(incarnation)

    assert 1 =
             DeliveryStates.issue_synthetic(
               "recipient",
               %{sender: "sender", conversation_id: "stale-stage-cid", turn_number: 1},
               name
             )

    report = %{
      "incarnation" => "old-incarnation",
      "generation" => "generation",
      "delivery_seq" => 1,
      "stage" => "submitted",
      "handoff" => "prompt_hook",
      "at" => DateTime.utc_now() |> DateTime.to_iso8601()
    }

    assert {:error, :stale_channel} =
             DeliveryStates.report_stage("recipient", "generation", owner, report, name)

    assert {:ok, %{stages: stages}} =
             DeliveryStates.message_status("sender", "stale-stage-cid", 1, name)

    refute Map.has_key?(stages, "submitted")

    assert :ok =
             DeliveryStates.report_stage(
               "recipient",
               "generation",
               owner,
               %{report | "incarnation" => incarnation},
               name
             )
  end

  test "V30f old channel owner cannot resolve a current sequence", %{name: name} do
    old_owner = self()

    new_owner =
      spawn(fn ->
        receive do
          :stop -> :ok
        end
      end)

    on_exit(fn -> send(new_owner, :stop) end)
    DeliveryStates.bind_resync("recipient", "generation", old_owner, name)
    incarnation = DeliveryStates.incarnation("recipient", name)

    assert 1 =
             DeliveryStates.issue_synthetic(
               "recipient",
               %{sender: "sender", conversation_id: "old-owner-cid", turn_number: 1},
               name
             )

    DeliveryStates.bind_resync("recipient", "generation", new_owner, name)

    report = %{
      "incarnation" => incarnation,
      "generation" => "generation",
      "delivery_seq" => 1,
      "stage" => "submitted",
      "handoff" => "prompt_hook",
      "at" => DateTime.utc_now() |> DateTime.to_iso8601()
    }

    assert {:error, :invalid_delivery_stage} =
             DeliveryStates.report_stage("recipient", "generation", old_owner, report, name)

    assert {:error, :invalid_delivery_stage} =
             DeliveryStates.report_stage(
               "recipient",
               "generation",
               new_owner,
               %{report | "generation" => "old-generation"},
               name
             )

    assert :sys.get_state(name).entries["recipient"].resolved == []
    assert :ok = DeliveryStates.report_stage("recipient", "generation", new_owner, report, name)
  end

  test "range retirement counts only unresolved work and preserves submitted history", %{
    name: name
  } do
    owner = self()
    DeliveryStates.bind_resync("recipient", "generation", owner, name)
    incarnation = :sys.get_state(name).entries["recipient"].incarnation

    for turn <- 1..2 do
      assert ^turn =
               DeliveryStates.issue_synthetic(
                 "recipient",
                 %{sender: "sender", conversation_id: "range-cid", turn_number: turn},
                 name
               )
    end

    assert :ok =
             DeliveryStates.report_stage(
               "recipient",
               "generation",
               owner,
               %{
                 "incarnation" => incarnation,
                 "generation" => "generation",
                 "delivery_seq" => 2,
                 "stage" => "submitted",
                 "handoff" => "prompt_hook",
                 "at" => DateTime.utc_now() |> DateTime.to_iso8601()
               },
               name
             )

    assert {:ok, %{acked_seq: 2, lost_count: 1, last_loss: %{count: 1, reason: "delivery_lost"}}} =
             DeliveryStates.resync("recipient", "generation", owner, 2, [[1, 2]], name)

    assert {:ok, %{stages: %{"submitted" => _}}} =
             DeliveryStates.message_status("sender", "range-cid", 2, name)
  end

  test "V30b V30c generation retirement loses only the unresolved sequence", %{name: name} do
    owner = self()
    DeliveryStates.bind_resync("recipient", "generation", owner, name)
    incarnation = DeliveryStates.incarnation("recipient", name)

    for turn <- 1..2 do
      assert ^turn =
               DeliveryStates.issue_synthetic(
                 "recipient",
                 %{sender: "sender", conversation_id: "owned-retirement-cid", turn_number: turn},
                 name
               )
    end

    assert :ok =
             DeliveryStates.report_stage(
               "recipient",
               "generation",
               owner,
               %{
                 "incarnation" => incarnation,
                 "generation" => "generation",
                 "delivery_seq" => 2,
                 "stage" => "submitted",
                 "handoff" => "prompt_hook",
                 "at" => DateTime.utc_now() |> DateTime.to_iso8601()
               },
               name
             )

    assert {:ok, %{acked_seq: 2, lost_count: 1, last_loss: %{count: 1}}} =
             DeliveryStates.retire_owned_generation("recipient", "generation", owner, name)

    assert {:ok, %{stages: stages}} =
             DeliveryStates.message_status("sender", "owned-retirement-cid", 2, name)

    assert Map.has_key?(stages, "submitted")
    refute Map.has_key?(stages, "lost")
    DeliveryStates.bind_resync("recipient", "new-generation", owner, name)

    assert {:ok, %{stages: stages}} =
             DeliveryStates.message_status("sender", "owned-retirement-cid", 2, name)

    refute Map.has_key?(stages, "lost")
  end

  test "yield disposition is set once while stage timestamps merge", %{name: name} do
    owner = self()
    DeliveryStates.bind_resync("recipient", "generation", owner, name)
    incarnation = :sys.get_state(name).entries["recipient"].incarnation

    assert 1 =
             DeliveryStates.issue_synthetic(
               "recipient",
               %{sender: "sender", conversation_id: "disposition-cid", turn_number: 1},
               name
             )

    at = DateTime.utc_now() |> DateTime.to_iso8601()

    base = %{
      "incarnation" => incarnation,
      "generation" => "generation",
      "delivery_seq" => 1,
      "at" => at
    }

    assert :ok =
             DeliveryStates.report_stage(
               "recipient",
               "generation",
               owner,
               Map.merge(base, %{
                 "stage" => "settled",
                 "yield_disposition" => %{
                   "outcome" => "downgraded",
                   "reason" => "mixed_turn",
                   "at" => at
                 }
               }),
               name
             )

    assert :ok =
             DeliveryStates.report_stage(
               "recipient",
               "generation",
               owner,
               Map.merge(base, %{"stage" => "submitted", "handoff" => "prompt_hook"}),
               name
             )

    assert :ok =
             DeliveryStates.report_stage(
               "recipient",
               "generation",
               owner,
               Map.put(base, "stage", "queued"),
               name
             )

    later = DateTime.utc_now() |> DateTime.add(1, :second) |> DateTime.to_iso8601()

    assert :ok =
             DeliveryStates.report_stage(
               "recipient",
               "generation",
               owner,
               base |> Map.put("stage", "queued") |> Map.put("at", later),
               name
             )

    assert {:error, :invalid_delivery_stage} =
             DeliveryStates.report_stage(
               "recipient",
               "generation",
               owner,
               Map.merge(base, %{
                 "stage" => "unknown",
                 "yield_disposition" => %{"outcome" => "cut", "at" => at}
               }),
               name
             )

    assert {:ok,
            %{
              stages: %{"settled" => ^at, "submitted" => ^at, "queued" => ^at},
              yield_disposition: %{"outcome" => "downgraded"}
            }} =
             DeliveryStates.message_status("sender", "disposition-cid", 1, name)
  end

  test "old stage history expires without clearing unresolved delivery metadata", %{name: name} do
    owner = self()
    DeliveryStates.bind_resync("recipient", "generation", owner, name)
    incarnation = :sys.get_state(name).entries["recipient"].incarnation

    assert 1 =
             DeliveryStates.issue_synthetic(
               "recipient",
               %{sender: "sender", conversation_id: "expired-stage-cid", turn_number: 1},
               name
             )

    assert :ok =
             DeliveryStates.report_stage(
               "recipient",
               "generation",
               owner,
               %{
                 "incarnation" => incarnation,
                 "generation" => "generation",
                 "delivery_seq" => 1,
                 "stage" => "queued",
                 "at" => DateTime.utc_now() |> DateTime.to_iso8601()
               },
               name
             )

    key = {"recipient", incarnation}
    assert %{^key => %{1 => _}} = :sys.get_state(name).entries["recipient"].stage_history

    :sys.replace_state(name, fn state ->
      entry = state.entries["recipient"]
      old = "2020-01-01T00:00:00Z"
      entry = put_in(entry.stage_history[key][1].changed_at, old)

      %{
        state
        | entries: Map.put(state.entries, "recipient", entry),
          stages: put_in(state.stages[key][1].changed_at, old)
      }
    end)

    assert {:ok, %{status: "expired"}} =
             DeliveryStates.message_status("sender", "expired-stage-cid", 1, name)

    assert {:ok, %{lost_count: 1}} =
             DeliveryStates.retire_owned_generation("recipient", "generation", owner, name)

    assert [%{reason: "interrupted", descriptor: %{conversation_id: "expired-stage-cid"}}] =
             DeliveryStates.pending_losses(name)
  end

  test "V30h resolved history expires after prefix reclamation without a loss", %{name: name} do
    owner = self()
    DeliveryStates.bind_resync("recipient", "generation", owner, name)
    incarnation = DeliveryStates.incarnation("recipient", name)

    assert 1 =
             DeliveryStates.issue_synthetic(
               "recipient",
               %{sender: "sender", conversation_id: "resolved-expiry-cid", turn_number: 1},
               name
             )

    assert :ok =
             DeliveryStates.report_stage(
               "recipient",
               "generation",
               owner,
               %{
                 "incarnation" => incarnation,
                 "generation" => "generation",
                 "delivery_seq" => 1,
                 "stage" => "submitted",
                 "handoff" => "prompt_hook",
                 "at" => DateTime.utc_now() |> DateTime.to_iso8601()
               },
               name
             )

    assert %{acked_seq: 1} =
             DeliveryStates.acknowledge("recipient", "generation", owner, 1, name)

    assert %{acked_seq: 1, lost_count: 0} = DeliveryStates.get("recipient", name)

    assert {:ok, %{stages: %{"submitted" => _}}} =
             DeliveryStates.message_status("sender", "resolved-expiry-cid", 1, name)

    key = {"recipient", incarnation}

    :sys.replace_state(name, fn state ->
      entry = state.entries["recipient"]
      old = "2020-01-01T00:00:00Z"
      entry = put_in(entry.stage_history[key][1].changed_at, old)

      %{
        state
        | entries: Map.put(state.entries, "recipient", entry),
          stages: put_in(state.stages[key][1].changed_at, old)
      }
    end)

    assert {:ok, %{status: "expired"}} =
             DeliveryStates.message_status("sender", "resolved-expiry-cid", 1, name)

    assert %{acked_seq: 1, lost_count: 0} = DeliveryStates.get("recipient", name)
  end

  test "V34a stage history retains exactly the newest 2000 records", %{name: name} do
    owner = self()
    DeliveryStates.bind_resync("recipient", "generation", owner, name)

    assert Application.fetch_env!(:kaoiro_server, :delivery_intent)[:delivery_stage_max_records] ==
             2_000

    for turn <- 1..2_001 do
      assert ^turn =
               DeliveryStates.issue_synthetic(
                 "recipient",
                 %{sender: "sender", conversation_id: "stage-bound-cid", turn_number: turn},
                 name
               )

      assert %{acked_seq: ^turn} =
               DeliveryStates.acknowledge("recipient", "generation", owner, turn, name)
    end

    history = :sys.get_state(name).entries["recipient"].stage_history

    assert 2_000 ==
             Enum.reduce(history, 0, fn {_key, records}, count -> count + map_size(records) end)

    assert {:ok, %{status: "expired"}} =
             DeliveryStates.message_status("sender", "stage-bound-cid", 1, name)

    assert {:ok, %{stages: %{"accepted" => _}}} =
             DeliveryStates.message_status("sender", "stage-bound-cid", 2_001, name)
  end

  test "legacy DETS watermarks migrate without inventing sender information", %{
    name: name,
    path: path
  } do
    GenServer.stop(Process.whereis(name))
    {:ok, table} = :dets.open_file(name, file: String.to_charlist(path))
    :ok = :dets.insert(table, {"recipient", "generation", 3, 1, "2026-09-18T00:00:00Z"})
    :ok = :dets.close(table)
    start_supervised!({DeliveryStates, name: name, path: path})

    assert %{issued_seq: 3, acked_seq: 1} =
             DeliveryStates.bind_resync("recipient", "generation", self(), name)

    assert {:ok, %{acked_seq: 3, lost_count: 2, last_loss: %{reason: "untraceable"}}} =
             DeliveryStates.resync("recipient", "generation", self(), 3, [[2, 3]], name)
  end

  test "retiring the first missing sequence immediately releases the prefix", %{name: name} do
    DeliveryStates.bind_resync("recipient", "generation", self(), name)
    for _ <- 1..3, do: DeliveryStates.issue("recipient", name)

    assert {:ok, %{acked_seq: 1, lost_count: 1}} =
             DeliveryStates.resync("recipient", "generation", self(), 3, [[1, 1]], name)

    assert %{acked_seq: 3, pending_since: nil} =
             DeliveryStates.acknowledge("recipient", "generation", self(), 3, name)
  end

  test "skip advances only a resolved prefix and persists idempotent loss", %{
    name: name,
    path: path
  } do
    DeliveryStates.bind_resync("recipient", "generation", self(), name)
    for _ <- 1..3, do: DeliveryStates.issue("recipient", name)

    assert {:ok, %{acked_seq: 0, lost_count: 1}} =
             DeliveryStates.resync("recipient", "generation", self(), 3, [[2, 2]], name)

    assert {:ok, %{acked_seq: 0, lost_count: 1}} =
             DeliveryStates.resync("recipient", "generation", self(), 3, [[2, 2]], name)

    GenServer.stop(Process.whereis(name))
    start_supervised!({DeliveryStates, name: name, path: path})

    assert {:error, :stale_delivery_owner} =
             DeliveryStates.resync("recipient", "generation", self(), 3, [[2, 2]], name)

    DeliveryStates.bind_resync("recipient", "generation", self(), name)

    assert %{acked_seq: 2, lost_count: 1} =
             DeliveryStates.acknowledge("recipient", "generation", self(), 1, name)

    assert %{acked_seq: 3, pending_since: nil, last_loss: %{reason: "untraceable"}} =
             DeliveryStates.acknowledge("recipient", "generation", self(), 3, name)
  end

  test "recovery rejects stale owners, generations, unnegotiated and invalid ranges", %{
    name: name
  } do
    DeliveryStates.bind_resync("recipient", "generation", self(), name)
    DeliveryStates.issue("recipient", name)

    for ranges <- [[], [[0, 1]], [[1, 2]], [[1, 1], [1, 1]], [[1, 1.5]], "bad"] do
      assert {:error, :invalid_delivery_resync} =
               DeliveryStates.resync("recipient", "generation", self(), 1, ranges, name)
    end

    assert {:error, :stale_delivery_owner} =
             DeliveryStates.resync("recipient", "old", self(), 1, [[1, 1]], name)

    assert {:error, :stale_delivery_owner} =
             DeliveryStates.resync("recipient", "generation", :wrong_owner, 1, [[1, 1]], name)

    assert {:error, :stale_delivery_owner} = DeliveryStates.ack("recipient", 1, name)
    assert %{acked_seq: 0, lost_count: 0} = DeliveryStates.get("recipient", name)
    DeliveryStates.bind_resync("recipient", "new", self(), name)

    assert {:error, :stale_delivery_owner} =
             DeliveryStates.acknowledge("recipient", "generation", self(), 1, name)

    assert %{acked_seq: 1, lost_count: 0} = DeliveryStates.get("recipient", name)
    DeliveryStates.bind("legacy", "generation", name)
    DeliveryStates.issue("legacy", name)

    assert {:error, :stale_delivery_owner} =
             DeliveryStates.resync("legacy", "generation", self(), 1, [[1, 1]], name)

    refute Map.has_key?(DeliveryStates.get("legacy", name), :lost_count)
  end

  test "whole-generation retirement is owner and generation fenced", %{name: name} do
    owner = self()
    DeliveryStates.bind_resync("recipient", "generation", owner, name)

    assert 1 =
             DeliveryStates.issue_synthetic(
               "recipient",
               %{sender: "sender", conversation_id: "cid", turn_number: 1, kind: "request"},
               name
             )

    assert 2 = DeliveryStates.issue("recipient", name)

    assert {:error, :stale_delivery_owner} =
             DeliveryStates.retire_owned_generation("recipient", "old", owner, name)

    assert {:error, :stale_delivery_owner} =
             DeliveryStates.retire_owned_generation("recipient", "generation", :stale, name)

    assert %{acked_seq: 0, lost_count: 0} = DeliveryStates.get("recipient", name)

    assert {:ok,
            %{acked_seq: 2, issued_seq: 2, pending_since: nil, lost_count: 2, last_loss: loss}} =
             DeliveryStates.retire_owned_generation("recipient", "generation", owner, name)

    assert loss.reason == "interrupted"

    assert [%{reason: "interrupted", recipient: "recipient"}] =
             DeliveryStates.pending_losses(name)
  end

  test "same generation reconnect retains a real gap; new process generation abandons it", %{
    name: name
  } do
    assert %{issued_seq: 0, acked_seq: 0, pending_since: nil} =
             DeliveryStates.bind("momo", "generation-a", name)

    assert 1 = DeliveryStates.issue("momo", name)

    assert %{issued_seq: 1, acked_seq: 0, pending_since: pending} =
             DeliveryStates.get("momo", name)

    assert %{issued_seq: 1, acked_seq: 0, pending_since: ^pending} =
             DeliveryStates.bind("momo", "generation-a", name)

    assert %{issued_seq: 1, acked_seq: 1, pending_since: nil} =
             DeliveryStates.bind("momo", "generation-b", name)
  end

  test "ack is bounded and does not slide first pending timestamp", %{name: name} do
    DeliveryStates.bind("momo", "generation-a", name)
    assert 1 = DeliveryStates.issue("momo", name)
    assert %{pending_since: pending} = DeliveryStates.get("momo", name)
    assert 2 = DeliveryStates.issue("momo", name)

    assert %{issued_seq: 2, acked_seq: 1, pending_since: ^pending} =
             DeliveryStates.ack("momo", 1, name)

    assert %{issued_seq: 2, acked_seq: 1, pending_since: ^pending} =
             DeliveryStates.ack("momo", 99, name)

    assert %{issued_seq: 2, acked_seq: 2, pending_since: nil} =
             DeliveryStates.ack("momo", 2, name)
  end

  test "restart preserves a pending observation instead of turning it into healthy", %{
    name: name,
    path: path
  } do
    DeliveryStates.bind("momo", "generation-a", name)
    assert 1 = DeliveryStates.issue("momo", name)
    assert %{pending_since: pending} = DeliveryStates.get("momo", name)

    GenServer.stop(Process.whereis(name))
    {:ok, _} = DeliveryStates.start_link(name: name, path: path)

    assert %{issued_seq: 1, acked_seq: 0, pending_since: ^pending} =
             DeliveryStates.get("momo", name)
  end

  test "wire projection は store を変えずに実運用上限へ収める", %{name: name} do
    for n <- 1..201 do
      id = "agent-#{String.pad_leading(Integer.to_string(n), 3, "0")}"
      assert %{issued_seq: 0} = DeliveryStates.bind(id, "generation-#{n}", name)
    end

    {projection, incomplete?} = DeliveryStates.wire_projection(name)

    assert map_size(DeliveryStates.all(name)) == 201
    assert incomplete?
    assert map_size(projection) == 200
    assert Map.has_key?(projection, "agent-001")
    refute Map.has_key?(projection, "agent-201")
  end

  test "wire projection は接続中または未確認 gap の delivery を優先し、省略を明示する" do
    historical =
      Map.new(1..200, fn n ->
        id = "agent-#{String.pad_leading(Integer.to_string(n), 3, "0")}"
        {id, %{issued_seq: 4, acked_seq: 4, pending_since: nil}}
      end)

    deliveries =
      historical
      |> Map.put("z-live", %{issued_seq: 2, acked_seq: 2, pending_since: nil})
      |> Map.put("z-gap", %{issued_seq: 3, acked_seq: 2, pending_since: "2026-08-28T00:00:00Z"})

    {projection, incomplete?} =
      DeliveryStates.wire_projection(deliveries, MapSet.new(["z-live"]))

    assert incomplete?
    assert map_size(projection) == 200
    assert Map.has_key?(projection, "z-live")
    assert Map.has_key?(projection, "z-gap")
    refute Map.has_key?(projection, "agent-200")
  end

  describe "records ending on unknown are terminal for retention" do
    setup %{name: name} do
      owner = self()
      DeliveryStates.bind_resync("recipient", "generation", owner, name)
      incarnation = DeliveryStates.incarnation("recipient", name)
      %{owner: owner, incarnation: incarnation, key: {"recipient", incarnation}}
    end

    test "an unknown-ending record expires on the terminal schedule, a queued one does not",
         %{name: name} = ctx do
      unknown = retention_record(ctx, "unknown-cid", ["queued", "unknown"])
      queued = retention_record(ctx, "queued-cid", ["queued"])

      assert "unknown" == internal_record(name, ctx.key, unknown).last_stage
      assert {:ok, reply} = DeliveryStates.message_status("sender", "queued-cid", 1, name)
      refute Map.has_key?(reply, :last_stage)

      age_records(name, ctx.key, [unknown, queued], 2)

      assert {:ok, %{status: "expired"}} =
               DeliveryStates.message_status("sender", "unknown-cid", 1, name)

      assert {:ok, %{stages: %{"queued" => _}}} =
               DeliveryStates.message_status("sender", "queued-cid", 1, name)
    end

    test "a later report after unknown keeps the record non-terminal", %{name: name} = ctx do
      submitted = retention_record(ctx, "submitted-cid", ["queued", "unknown", "submitted"])
      repeated = retention_record(ctx, "repeated-cid", ["queued", "unknown", "queued"])
      age_records(name, ctx.key, [submitted, repeated], 2)

      assert {:ok, %{stages: %{"unknown" => _, "submitted" => _}}} =
               DeliveryStates.message_status("sender", "submitted-cid", 1, name)

      assert {:ok, %{stages: %{"unknown" => _, "queued" => _}}} =
               DeliveryStates.message_status("sender", "repeated-cid", 1, name)
    end

    test "settled still expires on the terminal schedule", %{name: name} = ctx do
      settled = retention_record(ctx, "settled-cid", ["queued", "settled"])
      age_records(name, ctx.key, [settled], 2)

      assert {:ok, %{status: "expired"}} =
               DeliveryStates.message_status("sender", "settled-cid", 1, name)
    end

    test "a record persisted without last_stage keeps the settled/lost rule",
         %{name: name} = ctx do
      legacy = retention_record(ctx, "legacy-cid", ["queued", "unknown"])

      :sys.replace_state(name, fn state ->
        drop = &Map.delete(&1, :last_stage)
        entry = state.entries["recipient"]
        entry = update_in(entry.stage_history[ctx.key][legacy], drop)
        stages = state.stages

        %{
          state
          | entries: Map.put(state.entries, "recipient", entry),
            stages: update_in(stages[ctx.key][legacy], drop)
        }
      end)

      age_records(name, ctx.key, [legacy], 2)

      assert {:ok, %{stages: %{"unknown" => _}}} =
               DeliveryStates.message_status("sender", "legacy-cid", 1, name)
    end

    test "at the cap an unknown-ending record is dropped before an older non-terminal one",
         %{name: name} = ctx do
      previous = Application.fetch_env!(:kaoiro_server, :delivery_intent)

      Application.put_env(
        :kaoiro_server,
        :delivery_intent,
        Keyword.put(previous, :delivery_stage_max_records, 2)
      )

      on_exit(fn -> Application.put_env(:kaoiro_server, :delivery_intent, previous) end)

      older = retention_record(ctx, "older-cid", ["queued"])
      unknown = retention_record(ctx, "newer-unknown-cid", ["queued", "unknown"])
      age_records(name, ctx.key, [older], 0.5)
      age_records(name, ctx.key, [unknown], 0.25)
      retention_record(ctx, "third-cid", [])

      assert {:ok, %{status: "expired"}} =
               DeliveryStates.message_status("sender", "newer-unknown-cid", 1, name)

      assert {:ok, %{stages: %{"queued" => _}}} =
               DeliveryStates.message_status("sender", "older-cid", 1, name)
    end

    test "last_stage survives DETS persistence and a restart", %{name: name, path: path} = ctx do
      unknown = retention_record(ctx, "persisted-cid", ["queued", "unknown"])

      GenServer.stop(Process.whereis(name))
      {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
      [{"recipient", _, _, _, _, recovery}] = :dets.lookup(name, "recipient")
      assert "unknown" == recovery.stage_history[ctx.key][unknown].last_stage
      :ok = :dets.close(name)

      {:ok, _} = DeliveryStates.start_link(name: name, path: path)
      assert "unknown" == internal_record(name, ctx.key, unknown).last_stage
      age_records(name, ctx.key, [unknown], 2)

      assert {:ok, %{status: "expired"}} =
               DeliveryStates.message_status("sender", "persisted-cid", 1, name)
    end
  end

  # Issues one synthetic delivery for `cid` and reports `stages` in order.
  defp retention_record(%{owner: owner, incarnation: incarnation} = ctx, cid, stages) do
    name = ctx.name

    seq =
      DeliveryStates.issue_synthetic(
        "recipient",
        %{sender: "sender", conversation_id: cid, turn_number: 1},
        name
      )

    for stage <- stages do
      report =
        %{
          "incarnation" => incarnation,
          "generation" => "generation",
          "delivery_seq" => seq,
          "stage" => stage,
          "at" => DateTime.utc_now() |> DateTime.to_iso8601()
        }
        |> Map.merge(if(stage == "submitted", do: %{"handoff" => "prompt_hook"}, else: %{}))

      assert :ok = DeliveryStates.report_stage("recipient", "generation", owner, report, name)
    end

    seq
  end

  defp internal_record(name, key, seq),
    do: :sys.get_state(name).entries["recipient"].stage_history[key][seq]

  # Moves `changed_at` back by `hours` in both copies the store keeps.
  defp age_records(name, key, seqs, hours) do
    at =
      DateTime.utc_now()
      |> DateTime.add(-round(hours * 3_600_000), :millisecond)
      |> DateTime.to_iso8601()

    :sys.replace_state(name, fn state ->
      Enum.reduce(seqs, state, fn seq, state ->
        entry = state.entries["recipient"]
        entry = put_in(entry.stage_history[key][seq].changed_at, at)
        stages = state.stages

        %{
          state
          | entries: Map.put(state.entries, "recipient", entry),
            stages: put_in(stages[key][seq].changed_at, at)
        }
      end)
    end)
  end
end
