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

    key = {"recipient", incarnation}
    assert "lost" == :sys.get_state(name).entries["recipient"].stage_history[key][1].last_stage

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
      stages = state.stages

      %{
        state
        | entries: Map.put(state.entries, "recipient", entry),
          stages: put_in(stages[key][1].changed_at, old)
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
      stages = state.stages

      %{
        state
        | entries: Map.put(state.entries, "recipient", entry),
          stages: put_in(stages[key][1].changed_at, old)
      }
    end)

    assert {:ok, %{status: "expired"}} =
             DeliveryStates.message_status("sender", "resolved-expiry-cid", 1, name)

    assert %{acked_seq: 1, lost_count: 0} = DeliveryStates.get("recipient", name)
  end

  # Driving 2,000 records through the API costs about 60 s (one DETS sync
  # per call, issue #449). Seed records 2..2000 from the first real record,
  # then cross the default cap with one real delivery.
  test "V34a stage history retains exactly the newest 2000 records", %{name: name} do
    owner = self()
    DeliveryStates.bind_resync("recipient", "generation", owner, name)

    assert Application.fetch_env!(:kaoiro_server, :delivery_intent)[:delivery_stage_max_records] ==
             2_000

    deliver = fn turn ->
      assert ^turn =
               DeliveryStates.issue_synthetic(
                 "recipient",
                 %{sender: "sender", conversation_id: "stage-bound-cid", turn_number: turn},
                 name
               )

      assert %{acked_seq: ^turn} =
               DeliveryStates.acknowledge("recipient", "generation", owner, turn, name)
    end

    deliver.(1)

    :sys.replace_state(name, fn state ->
      entry = state.entries["recipient"]
      [{key, %{1 => first}}] = Map.to_list(entry.stage_history)
      {:ok, first_at, _} = DateTime.from_iso8601(first.changed_at)

      seeded =
        Map.new(2..2_000, fn seq ->
          at = first_at |> DateTime.add(seq, :millisecond) |> DateTime.to_iso8601()

          {seq,
           %{
             first
             | delivery_seq: seq,
               turn_number: seq,
               stages: %{"accepted" => at},
               changed_at: at
           }}
        end)

      history = %{key => Map.merge(%{1 => first}, seeded)}
      entry = %{entry | stage_history: history, issued_seq: 2_000, acked_seq: 2_000}
      %{state | entries: Map.put(state.entries, "recipient", entry), stages: history}
    end)

    deliver.(2_001)

    history = :sys.get_state(name).entries["recipient"].stage_history

    assert 2_000 ==
             Enum.reduce(history, 0, fn {_key, records}, count -> count + map_size(records) end)

    assert {:ok, %{status: "expired"}} =
             DeliveryStates.message_status("sender", "stage-bound-cid", 1, name)

    for turn <- [2, 2_000, 2_001] do
      assert {:ok, %{stages: %{"accepted" => _}}} =
               DeliveryStates.message_status("sender", "stage-bound-cid", turn, name)
    end
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

  test "a superseded generation retains one interrupted loss in either retirement order", %{
    name: name
  } do
    for order <- [:retire_before_bind, :bind_before_retire] do
      recipient = "watchdog-#{order}"
      owner = self()
      DeliveryStates.bind_resync(recipient, "old", owner, name)

      assert 1 =
               DeliveryStates.issue_synthetic(
                 recipient,
                 %{sender: "sender", conversation_id: recipient, turn_number: 1},
                 name
               )

      if order == :retire_before_bind do
        assert {:ok, %{acked_seq: 1}} =
                 DeliveryStates.retire(recipient, "old", owner, 1, [[1, 1]], name)
      end

      assert %{issued_seq: 1, acked_seq: 1} =
               DeliveryStates.bind_resync(recipient, "new", owner, name)

      assert {:error, :stale_delivery_owner} =
               DeliveryStates.retire(recipient, "old", owner, 1, [[1, 1]], name)

      assert [%{generation: "old", seq: 1, reason: "interrupted"}] =
               Enum.filter(DeliveryStates.pending_losses(name), &(&1.recipient == recipient))

      assert {:ok, %{stages: %{"lost" => _}}} =
               DeliveryStates.message_status("sender", recipient, 1, name)
    end
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

  test "only a fenced, possibly written early steer resolves an unknown without loss", %{
    name: name,
    path: path
  } do
    recipient = "phase3-recipient"
    owner = self()
    DeliveryStates.bind_resync(recipient, "generation", owner, name)
    incarnation = DeliveryStates.incarnation(recipient, name)
    at = DateTime.utc_now() |> DateTime.to_iso8601()

    assert 1 =
             DeliveryStates.issue_synthetic(
               recipient,
               %{sender: "sender", conversation_id: "phase3", turn_number: 1, mode: "early"},
               name
             )

    base = %{
      "incarnation" => incarnation,
      "generation" => "generation",
      "delivery_seq" => 1,
      "mode" => "early",
      "at" => at
    }

    for changed <- [
          Map.merge(base, %{"stage" => "unknown", "reason" => "turn_steer_timeout"}),
          Map.merge(base, %{
            "stage" => "unknown",
            "handoff" => "turn_steer_write_uncertain",
            "reason" => "arbitrary"
          }),
          Map.merge(base, %{
            "stage" => "unknown",
            "handoff" => "turn_steer_write_uncertain",
            "reason" => "turn_steer_timeout",
            "generation" => "old"
          }),
          Map.merge(base, %{
            "stage" => "unknown",
            "handoff" => "turn_steer_write_uncertain",
            "reason" => "turn_steer_timeout",
            "incarnation" => "old"
          })
        ] do
      assert {:error, _} =
               DeliveryStates.report_stage(recipient, "generation", owner, changed, name)
    end

    uncertain =
      Map.merge(base, %{
        "stage" => "unknown",
        "handoff" => "turn_steer_write_uncertain",
        "reason" => "turn_steer_timeout"
      })

    assert {:error, _} =
             DeliveryStates.report_stage(
               recipient,
               "generation",
               spawn(fn -> :ok end),
               uncertain,
               name
             )

    assert :ok = DeliveryStates.report_stage(recipient, "generation", owner, uncertain, name)

    assert {:error, :invalid_delivery_stage} =
             DeliveryStates.report_stage(
               recipient,
               "generation",
               owner,
               Map.merge(base, %{"stage" => "settled", "reason" => "turn_end"}),
               name
             )

    assert :ok = DeliveryStates.report_stage(recipient, "generation", owner, uncertain, name)

    assert %{uncertain_count: 1, lost_count: 0, last_uncertain: %{delivery_seq: 1}} =
             DeliveryStates.get(recipient, name)

    entry = :sys.get_state(name).entries[recipient]
    assert 1 in entry.resolved
    refute Map.has_key?(entry.metadata, 1)

    assert {:error, :invalid_delivery_stage} =
             DeliveryStates.report_stage(
               recipient,
               "generation",
               owner,
               Map.put(uncertain, "reason", "turn_steer_disconnected"),
               name
             )

    DeliveryStates.bind_resync(recipient, "new-generation", owner, name)
    assert %{uncertain_count: 1, lost_count: 0} = DeliveryStates.get(recipient, name)

    GenServer.stop(Process.whereis(name))
    {:ok, _} = DeliveryStates.start_link(name: name, path: path)

    assert %{uncertain_count: 1, last_uncertain: %{reason: "turn_steer_timeout"}} =
             DeliveryStates.bind_resync(recipient, "new-generation", owner, name)

    expired_at = DateTime.utc_now() |> DateTime.add(-7_200, :second) |> DateTime.to_iso8601()
    key = {recipient, incarnation}

    :sys.replace_state(name, fn state ->
      entry = state.entries[recipient]
      entry = put_in(entry.stage_history[key][1].changed_at, expired_at)

      %{
        state
        | entries: Map.put(state.entries, recipient, entry),
          stages: put_in(state.stages[key][1].changed_at, expired_at)
      }
    end)

    assert {:ok, %{status: "expired"}} =
             DeliveryStates.message_status("sender", "phase3", 1, name)

    assert %{uncertain_count: 1, lost_count: 0} = DeliveryStates.get(recipient, name)

    assert :ok = DeliveryStates.delete(recipient, name)

    assert %{uncertain_count: 0, last_uncertain: nil} =
             DeliveryStates.bind_resync(recipient, "fresh", owner, name)
  end

  test "an older persisted ledger initializes uncertainty without inventing a history count", %{
    name: name,
    path: path
  } do
    recipient = "phase3-old-format"
    owner = self()

    assert %{uncertain_count: 0} =
             DeliveryStates.bind_resync(recipient, "generation", owner, name)

    GenServer.stop(Process.whereis(name))
    {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))

    [{^recipient, generation, issued, acked, pending_since, recovery}] =
      :dets.lookup(name, recipient)

    :ok =
      :dets.insert(
        name,
        {recipient, generation, issued, acked, pending_since,
         Map.drop(recovery, [:uncertain_count, :last_uncertain])}
      )

    :ok = :dets.sync(name)
    :ok = :dets.close(name)

    {:ok, _} = DeliveryStates.start_link(name: name, path: path)

    assert %{uncertain_count: 0, last_uncertain: nil} =
             DeliveryStates.bind_resync(recipient, "generation", owner, name)
  end

  test "post-submission uncertainty counts once and legacy unknown remains history-only", %{
    name: name
  } do
    recipient = "phase3-submitted"
    owner = self()
    DeliveryStates.bind_resync(recipient, "generation", owner, name)
    incarnation = DeliveryStates.incarnation(recipient, name)
    at = DateTime.utc_now() |> DateTime.to_iso8601()

    for {seq, mode} <- [{1, "early"}, {2, "normal"}] do
      assert ^seq =
               DeliveryStates.issue_synthetic(
                 recipient,
                 %{
                   sender: "sender",
                   conversation_id: "phase3-#{seq}",
                   turn_number: seq,
                   mode: mode
                 },
                 name
               )
    end

    base = %{
      "incarnation" => incarnation,
      "generation" => "generation",
      "at" => at
    }

    submitted =
      Map.merge(base, %{
        "delivery_seq" => 1,
        "stage" => "submitted",
        "mode" => "early",
        "handoff" => "turn_steer_accepted"
      })

    assert :ok = DeliveryStates.report_stage(recipient, "generation", owner, submitted, name)

    uncertain =
      Map.merge(base, %{
        "delivery_seq" => 1,
        "stage" => "unknown",
        "mode" => "early",
        "reason" => "turn_steer_not_observed"
      })

    assert :ok = DeliveryStates.report_stage(recipient, "generation", owner, uncertain, name)
    assert :ok = DeliveryStates.report_stage(recipient, "generation", owner, uncertain, name)

    legacy =
      Map.merge(base, %{
        "delivery_seq" => 2,
        "stage" => "unknown",
        "mode" => "normal",
        "reason" => "legacy_timeout"
      })

    assert :ok = DeliveryStates.report_stage(recipient, "generation", owner, legacy, name)

    entry = :sys.get_state(name).entries[recipient]
    assert entry.resolved == [1]
    assert Map.has_key?(entry.metadata, 2)
    assert %{uncertain_count: 1, lost_count: 0} = DeliveryStates.get(recipient, name)

    assert {:error, :invalid_delivery_stage} =
             DeliveryStates.report_stage(
               recipient,
               "generation",
               owner,
               Map.put(uncertain, "reason", "turn_steer_item_conflict"),
               name
             )
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

  describe "a retirement and its loss intents" do
    @descriptor %{sender: "sender", conversation_id: "cid", turn_number: 1, kind: "request"}

    test "writes each intent as its own object before the recipient entry", %{name: name} do
      owner = self()
      DeliveryStates.bind_resync("recipient", "generation", owner, name)
      assert 1 = DeliveryStates.issue_synthetic("recipient", @descriptor, name)
      assert 2 = DeliveryStates.issue_synthetic("recipient", @descriptor, name)

      parent = self()

      tracer =
        spawn(fn ->
          for _ <- 1..3 do
            receive do
              event -> send(parent, {:dets_trace, event})
            end
          end
        end)

      pid = Process.whereis(name)
      :erlang.trace_pattern({:dets, :insert, 2}, true, [])
      :erlang.trace(pid, true, [:call, {:tracer, tracer}])

      try do
        assert {:ok, %{lost_count: 2}} =
                 DeliveryStates.retire("recipient", "generation", owner, 2, [[1, 2]], name)

        objects =
          for _ <- 1..3 do
            assert_receive {:dets_trace, {:trace, ^pid, :call, {:dets, :insert, [^name, object]}}}
            object
          end

        assert [{{:loss, _}, %{seq: 1}}, {{:loss, _}, %{seq: 2}}, entry] = objects
        assert elem(entry, 0) == "recipient"
      after
        :erlang.trace(pid, false, [:call])
        :erlang.trace_pattern({:dets, :insert, 2}, false, [])
      end
    end

    test "an intent whose retirement never committed is deleted at restart", %{
      name: name,
      path: path
    } do
      loss = uncommitted_retirement(name, path, "recipient")
      {:ok, _} = DeliveryStates.start_link(name: name, path: path)

      assert DeliveryStates.pending_losses(name) == []
      assert %{acked_seq: 0, lost_count: 0} = DeliveryStates.get("recipient", name)

      # Once the delivery is acknowledged the entry no longer holds its
      # metadata; an intent left on disk would then look committed.
      DeliveryStates.bind_resync("recipient", "generation", self(), name)

      assert %{acked_seq: 1} =
               DeliveryStates.acknowledge("recipient", "generation", self(), 1, name)

      GenServer.stop(Process.whereis(name))
      assert raw(name, path, &:dets.lookup(&1, {:loss, loss.id})) == []
      {:ok, _} = DeliveryStates.start_link(name: name, path: path)
      assert DeliveryStates.pending_losses(name) == []
    end

    test "the wrapper's resent retire rebuilds the dropped intent exactly once", %{
      name: name,
      path: path
    } do
      loss = uncommitted_retirement(name, path, "recipient")
      {:ok, _} = DeliveryStates.start_link(name: name, path: path)
      assert DeliveryStates.pending_losses(name) == []

      DeliveryStates.bind_resync("recipient", "generation", self(), name)

      assert {:ok, %{acked_seq: 1, lost_count: 1}} =
               DeliveryStates.retire("recipient", "generation", self(), 1, [[1, 1]], name)

      assert DeliveryStates.pending_losses(name) == [loss]
    end

    test "a bind under another generation rebuilds the dropped intent exactly once", %{
      name: name,
      path: path
    } do
      loss = uncommitted_retirement(name, path, "recipient")
      {:ok, _} = DeliveryStates.start_link(name: name, path: path)
      assert DeliveryStates.pending_losses(name) == []

      DeliveryStates.bind_resync("recipient", "replacement", self(), name)

      assert DeliveryStates.pending_losses(name) == [loss]
    end

    test "a committed intent survives a restart", %{name: name, path: path} do
      loss = committed_retirement(name, "recipient")
      GenServer.stop(Process.whereis(name))
      {:ok, _} = DeliveryStates.start_link(name: name, path: path)

      assert DeliveryStates.pending_losses(name) == [loss]
    end

    test "an intent outlives its recipient's entry", %{name: name, path: path} do
      loss = committed_retirement(name, "recipient")
      assert :ok = DeliveryStates.delete("recipient", name)
      GenServer.stop(Process.whereis(name))
      {:ok, _} = DeliveryStates.start_link(name: name, path: path)

      assert DeliveryStates.pending_losses(name) == [loss]
    end

    test "an intent survives a recreated entry that reissues the same sequence", %{
      name: name,
      path: path
    } do
      loss = committed_retirement(name, "recipient")
      assert :ok = DeliveryStates.delete("recipient", name)
      DeliveryStates.bind_resync("recipient", "generation", self(), name)
      assert 1 = DeliveryStates.issue_synthetic("recipient", @descriptor, name)
      GenServer.stop(Process.whereis(name))
      {:ok, _} = DeliveryStates.start_link(name: name, path: path)

      assert DeliveryStates.pending_losses(name) == [loss]
    end

    test "a retired loss notice that never committed is rebuilt under the original id", %{
      name: name,
      path: path
    } do
      original = committed_retirement(name, "recipient")

      # The dispatcher delivers the notice to the sender as a synthetic
      # delivery that carries the original loss id.
      notice = Map.put(@descriptor, :loss_id, original.id)
      DeliveryStates.bind_resync("sender", "sender-generation", self(), name)
      assert 1 = DeliveryStates.issue_synthetic("sender", notice, name)
      GenServer.stop(Process.whereis(name))
      [before_retirement] = raw(name, path, &:dets.lookup(&1, "sender"))

      # Retiring the notice overwrites the original intent under the same key.
      {:ok, _} = DeliveryStates.start_link(name: name, path: path)
      DeliveryStates.bind_resync("sender", "sender-generation", self(), name)

      assert {:ok, _} =
               DeliveryStates.retire("sender", "sender-generation", self(), 1, [[1, 1]], name)

      assert [%{id: id, revision: revision, recipient: "sender"} = replacement] =
               DeliveryStates.pending_losses(name)

      assert id == original.id
      assert revision != original.revision
      GenServer.stop(Process.whereis(name))
      raw(name, path, &:dets.insert(&1, before_retirement))

      {:ok, _} = DeliveryStates.start_link(name: name, path: path)
      assert DeliveryStates.pending_losses(name) == []

      DeliveryStates.bind_resync("sender", "sender-generation", self(), name)

      assert {:ok, _} =
               DeliveryStates.retire("sender", "sender-generation", self(), 1, [[1, 1]], name)

      assert DeliveryStates.pending_losses(name) == [replacement]
    end
  end

  defp raw(name, path, fun) do
    {:ok, table} = :dets.open_file(:"#{name}_raw", file: String.to_charlist(path))

    try do
      fun.(table)
    after
      :dets.close(table)
    end
  end

  # Issues seq 1 to `recipient` and retires it, leaving one committed intent.
  defp committed_retirement(name, recipient) do
    DeliveryStates.bind_resync(recipient, "generation", self(), name)
    assert 1 = DeliveryStates.issue_synthetic(recipient, @descriptor, name)

    assert {:ok, %{acked_seq: 1, lost_count: 1}} =
             DeliveryStates.retire(recipient, "generation", self(), 1, [[1, 1]], name)

    assert [loss] = DeliveryStates.pending_losses(name)
    loss
  end

  # Leaves the store stopped with the state a crash between the intent write
  # and the entry write produces: the intent on disk, the entry not retired.
  defp uncommitted_retirement(name, path, recipient) do
    DeliveryStates.bind_resync(recipient, "generation", self(), name)
    assert 1 = DeliveryStates.issue_synthetic(recipient, @descriptor, name)
    GenServer.stop(Process.whereis(name))
    [before_retirement] = raw(name, path, &:dets.lookup(&1, recipient))

    {:ok, _} = DeliveryStates.start_link(name: name, path: path)
    DeliveryStates.bind_resync(recipient, "generation", self(), name)

    assert {:ok, _} =
             DeliveryStates.retire(recipient, "generation", self(), 1, [[1, 1]], name)

    assert [loss] = DeliveryStates.pending_losses(name)
    GenServer.stop(Process.whereis(name))
    raw(name, path, &:dets.insert(&1, before_retirement))
    loss
  end

  describe "queue policy binding" do
    @policy %{batch_max_items: 10, backlog_max_items: 100, backlog_max_bytes: 524_288}

    test "a same-generation rejoin must declare the bound tuple", %{name: name} do
      first = self()
      second = spawn(fn -> :ok end)

      assert {:ok, _} = DeliveryStates.bind_queue("queue-recipient", "g1", first, @policy, name)

      assert {:error, :generation_mismatch} =
               DeliveryStates.bind_queue(
                 "queue-recipient",
                 "g1",
                 second,
                 %{@policy | backlog_max_items: 99},
                 name
               )

      # Nothing was bound by the refused join.
      state = :sys.get_state(name)
      assert state.owners["queue-recipient"] == first
      assert state.entries["queue-recipient"].queue_policy == @policy

      assert {:ok, _} = DeliveryStates.bind_queue("queue-recipient", "g1", second, @policy, name)
      assert :sys.get_state(name).owners["queue-recipient"] == second
    end

    test "a new generation establishes a new tuple", %{name: name} do
      lower = %{@policy | backlog_max_bytes: 16_384}
      assert {:ok, _} = DeliveryStates.bind_queue("queue-new-gen", "g1", self(), @policy, name)
      assert {:ok, _} = DeliveryStates.bind_queue("queue-new-gen", "g2", self(), lower, name)
      assert :sys.get_state(name).entries["queue-new-gen"].queue_policy == lower

      assert {:error, :generation_mismatch} =
               DeliveryStates.bind_queue("queue-new-gen", "g2", self(), @policy, name)
    end

    test "the bound tuple survives a restart", %{name: name, path: path} do
      assert {:ok, _} = DeliveryStates.bind_queue("queue-reload", "g1", self(), @policy, name)

      GenServer.stop(Process.whereis(name))
      {:ok, _} = DeliveryStates.start_link(name: name, path: path)

      assert {:error, :generation_mismatch} =
               DeliveryStates.bind_queue(
                 "queue-reload",
                 "g1",
                 self(),
                 %{@policy | batch_max_items: 11},
                 name
               )

      assert {:ok, _} = DeliveryStates.bind_queue("queue-reload", "g1", self(), @policy, name)
    end

    test "the queue epoch changes on every start", %{name: name, path: path} do
      epoch = DeliveryStates.queue_epoch(name)
      assert is_binary(epoch) and epoch != ""
      assert DeliveryStates.queue_epoch(name) == epoch

      GenServer.stop(Process.whereis(name))
      {:ok, _} = DeliveryStates.start_link(name: name, path: path)
      refute DeliveryStates.queue_epoch(name) == epoch
    end
  end

  describe "queue ownership" do
    @policy %{batch_max_items: 10, backlog_max_items: 2, backlog_max_bytes: 100}

    defp descriptor(sender, turn \\ 1),
      do: %{sender: sender, conversation_id: "c-" <> sender, turn_number: turn, kind: "inform"}

    defp enqueue(name, recipient, sender, bytes \\ 10) do
      {:ok, token, class} = DeliveryStates.queue_reserve(recipient, :ordinary, bytes, name)

      {:ok, queue_id} =
        DeliveryStates.queue_commit(recipient, token, descriptor(sender), %{"body" => "x"}, name)

      {queue_id, class}
    end

    test "a recipient without a bound queue refuses reservations", %{name: name} do
      assert DeliveryStates.queue_reserve("no-queue", :ordinary, 1, name) ==
               {:error, :queue_unavailable}

      assert DeliveryStates.queue_counts("no-queue", name) == nil
    end

    test "reserve and commit queue an item with its body", %{name: name} do
      {:ok, _} = DeliveryStates.bind_queue("q-owner", "g1", self(), @policy, name)
      {queue_id, :ordinary} = enqueue(name, "q-owner", "a")

      assert %{queued: 1, charged_bytes: 10, policy: @policy} =
               DeliveryStates.queue_counts("q-owner", name)

      assert :sys.get_state(name).bodies[{"q-owner", queue_id}] == %{"body" => "x"}

      assert %{queue: %{queued: 1, charged_bytes: 10}} = DeliveryStates.get("q-owner", name)
      assert DeliveryStates.unresolved_count("q-owner", name) == 1

      {:ok, _offer} = DeliveryStates.queue_offer("q-owner", "g1", self(), :root, name)
      # Offered, it is counted once, through its sequence.
      assert DeliveryStates.unresolved_count("q-owner", name) == 1
    end

    test "only the reserving process may commit", %{name: name} do
      {:ok, _} = DeliveryStates.bind_queue("q-foreign", "g1", self(), @policy, name)
      {:ok, token, _} = DeliveryStates.queue_reserve("q-foreign", :ordinary, 1, name)

      result =
        Task.async(fn ->
          DeliveryStates.queue_commit("q-foreign", token, descriptor("a"), %{}, name)
        end)
        |> Task.await()

      assert result == {:error, :invalid_queue_reservation}
      assert DeliveryStates.queue_counts("q-foreign", name).queued == 0
    end

    test "a reservation dies with its owner and a cancel releases it", %{name: name} do
      {:ok, _} = DeliveryStates.bind_queue("q-down", "g1", self(), @policy, name)
      parent = self()

      owner =
        spawn(fn ->
          send(parent, {:reserved, DeliveryStates.queue_reserve("q-down", :ordinary, 100, name)})
          receive do: (:exit -> :ok)
        end)

      assert_receive {:reserved, {:ok, _token, :ordinary}}

      assert DeliveryStates.queue_reserve("q-down", :ordinary, 1, name) ==
               {:error, :receiver_overloaded}

      ref = Process.monitor(owner)
      send(owner, :exit)
      assert_receive {:DOWN, ^ref, :process, _, _}

      assert {:ok, token, :ordinary} =
               DeliveryStates.queue_reserve("q-down", :ordinary, 100, name)

      assert :ok = DeliveryStates.queue_cancel(token, name)
      assert DeliveryStates.queue_counts("q-down", name).charged_bytes == 0
    end

    test "admission is bounded by the bound policy", %{name: name} do
      {:ok, _} = DeliveryStates.bind_queue("q-full", "g1", self(), @policy, name)
      enqueue(name, "q-full", "a")
      enqueue(name, "q-full", "a")

      assert DeliveryStates.queue_reserve("q-full", :ordinary, 1, name) ==
               {:error, :receiver_overloaded}
    end

    test "a server restart turns retained items into loss obligations", %{name: name, path: path} do
      {:ok, _} = DeliveryStates.bind_queue("q-restart", "g1", self(), @policy, name)
      {queue_id, _} = enqueue(name, "q-restart", "sender-a")

      for _ <- 1..2 do
        GenServer.stop(Process.whereis(name))
        {:ok, _} = DeliveryStates.start_link(name: name, path: path)
      end

      assert [loss] = DeliveryStates.pending_losses(name)

      assert %{
               recipient: "q-restart",
               queue_id: ^queue_id,
               seq: nil,
               reason: "delivery_lost",
               descriptor: %{sender: "sender-a", kind: "inform"}
             } = loss

      assert %{queued: 0, charged_bytes: 0} = DeliveryStates.queue_counts("q-restart", name)
      assert :sys.get_state(name).bodies == %{}

      assert :ok = DeliveryStates.complete_loss(loss.id, loss.revision, name)
      assert DeliveryStates.pending_losses(name) == []
    end

    test "a replacement generation keeps queued items and takes the new policy", %{name: name} do
      {:ok, _} = DeliveryStates.bind_queue("q-replace", "g1", self(), @policy, name)
      enqueue(name, "q-replace", "a")
      enqueue(name, "q-replace", "a")

      lower = %{@policy | backlog_max_items: 1}
      {:ok, _} = DeliveryStates.bind_queue("q-replace", "g2", self(), lower, name)

      assert %{queued: 2, policy: ^lower} = DeliveryStates.queue_counts("q-replace", name)

      assert DeliveryStates.queue_reserve("q-replace", :ordinary, 1, name) ==
               {:error, :receiver_overloaded}

      assert DeliveryStates.pending_losses(name) == []
    end

    test "legacy binds under a new generation keep the queue", %{name: name} do
      {:ok, _} = DeliveryStates.bind_queue("q-legacy", "g1", self(), @policy, name)
      enqueue(name, "q-legacy", "a")

      DeliveryStates.bind_resync("q-legacy", "g2", self(), name)
      assert DeliveryStates.queue_counts("q-legacy", name).queued == 1

      DeliveryStates.bind("q-legacy", "g3", name)
      assert DeliveryStates.queue_counts("q-legacy", name).queued == 1
    end

    test "deletion and disarm turn retained items into losses", %{name: name} do
      for {recipient, remove} <- [
            {"q-delete", &DeliveryStates.delete/2},
            {"q-disarm", &DeliveryStates.disarm/2}
          ] do
        {:ok, _} = DeliveryStates.bind_queue(recipient, "g1", self(), @policy, name)
        enqueue(name, recipient, "a")
        assert :ok = remove.(recipient, name)
      end

      assert ["q-delete", "q-disarm"] ==
               name |> DeliveryStates.pending_losses() |> Enum.map(& &1.recipient) |> Enum.sort()

      assert :sys.get_state(name).bodies == %{}
    end
  end

  describe "queue leases and sequences" do
    @lease_policy %{batch_max_items: 10, backlog_max_items: 10, backlog_max_bytes: 1_000}

    defp queued(name, recipient, count) do
      for n <- 1..count do
        {:ok, token, _} = DeliveryStates.queue_reserve(recipient, :ordinary, 5, name)

        {:ok, id} =
          DeliveryStates.queue_commit(
            recipient,
            token,
            %{sender: "s", conversation_id: "c", turn_number: n, kind: "inform"},
            %{"n" => n},
            name
          )

        id
      end
    end

    defp status(name, recipient), do: DeliveryStates.get(recipient, name)

    test "an offer allocates sequences, carries bodies and needs the delivery owner", %{
      name: name
    } do
      {:ok, _} = DeliveryStates.bind_queue("l-offer", "g1", self(), @lease_policy, name)
      [a, b] = queued(name, "l-offer", 2)

      other = spawn(fn -> :ok end)

      assert DeliveryStates.queue_offer("l-offer", "g1", other, :root, name) ==
               {:error, :stale_delivery_owner}

      assert {:ok, offer} = DeliveryStates.queue_offer("l-offer", "g1", self(), :root, name)

      assert [
               %{queue_id: ^a, delivery_seq: 1, body: %{"n" => 1}, attempt: 1, byte_charge: 5},
               %{queue_id: ^b, delivery_seq: 2, body: %{"n" => 2}}
             ] = offer.items

      assert %{issued_seq: 2, acked_seq: 0} = status(name, "l-offer")

      assert DeliveryStates.queue_offer("l-offer", "g1", self(), :root, name) ==
               {:error, :lease_slot_busy}
    end

    test "a cumulative ack never resolves a pending queue sequence", %{name: name} do
      {:ok, _} = DeliveryStates.bind_queue("l-ack", "g1", self(), @lease_policy, name)
      [a, b] = queued(name, "l-ack", 2)
      {:ok, offer} = DeliveryStates.queue_offer("l-ack", "g1", self(), :root, name)

      assert %{acked_seq: 0} = DeliveryStates.acknowledge("l-ack", "g1", self(), 2, name)

      {:ok, _} =
        DeliveryStates.queue_begin_native("l-ack", "g1", self(), offer.lease_id, [a], name)

      assert {:ok, %{resolved: [1]}} =
               DeliveryStates.queue_dispose(
                 "l-ack",
                 "g1",
                 self(),
                 offer.lease_id,
                 [{a, :observed}],
                 "t",
                 name
               )

      assert %{acked_seq: 1} = status(name, "l-ack")

      assert {:ok, %{returned: [2]}} =
               DeliveryStates.queue_return(
                 "l-ack",
                 "g1",
                 self(),
                 offer.lease_id,
                 [{b, :format_budget}],
                 "t",
                 name
               )

      assert %{acked_seq: 2, issued_seq: 2} = status(name, "l-ack")
      refute Map.has_key?(:sys.get_state(name).bodies, {"l-ack", a})
      assert :sys.get_state(name).bodies[{"l-ack", b}] == %{"n" => 2}

      assert {:ok, again} = DeliveryStates.queue_offer("l-ack", "g1", self(), :root, name)
      assert [%{queue_id: ^b, delivery_seq: 3, attempt: 2}] = again.items
    end

    test "an unknown outcome counts as uncertain and drops the body", %{name: name} do
      {:ok, _} = DeliveryStates.bind_queue("l-unknown", "g1", self(), @lease_policy, name)
      [a] = queued(name, "l-unknown", 1)
      {:ok, offer} = DeliveryStates.queue_offer("l-unknown", "g1", self(), :root, name)

      {:ok, _} =
        DeliveryStates.queue_begin_native("l-unknown", "g1", self(), offer.lease_id, [a], name)

      assert {:ok, %{uncertain: [1]}} =
               DeliveryStates.queue_dispose(
                 "l-unknown",
                 "g1",
                 self(),
                 offer.lease_id,
                 [{a, :unknown}],
                 "t",
                 name
               )

      assert %{
               acked_seq: 1,
               uncertain_count: 1,
               last_uncertain: %{delivery_seq: 1, reason: "queue_unknown"}
             } =
               status(name, "l-unknown")

      assert :sys.get_state(name).bodies == %{}
      assert %{charged_bytes: 0} = DeliveryStates.queue_counts("l-unknown", name)
    end

    test "a new generation returns offers, resolves native-pending as uncertain, keeps queued", %{
      name: name
    } do
      {:ok, _} =
        DeliveryStates.bind_queue(
          "l-gen",
          "g1",
          self(),
          %{@lease_policy | batch_max_items: 1},
          name
        )

      [a, b, c] = queued(name, "l-gen", 3)
      {:ok, first} = DeliveryStates.queue_offer("l-gen", "g1", self(), :root, name)

      {:ok, _} =
        DeliveryStates.queue_begin_native("l-gen", "g1", self(), first.lease_id, [a], name)

      {:ok, _second} = DeliveryStates.queue_offer("l-gen", "g1", self(), :root, name)

      {:ok, _} =
        DeliveryStates.bind_queue(
          "l-gen",
          "g2",
          self(),
          %{@lease_policy | batch_max_items: 1},
          name
        )

      assert %{queued: 2, offered: 0, native_pending: 0} =
               DeliveryStates.queue_counts("l-gen", name)

      assert %{uncertain_count: 1, acked_seq: 2} = status(name, "l-gen")
      refute Map.has_key?(:sys.get_state(name).bodies, {"l-gen", a})

      assert {:ok, offer} = DeliveryStates.queue_offer("l-gen", "g2", self(), :root, name)
      assert [%{queue_id: ^b, delivery_seq: 3, attempt: 2}] = offer.items
      _ = c
    end

    test "lease operations refuse a stale owner or an unknown lease", %{name: name} do
      {:ok, _} = DeliveryStates.bind_queue("l-refuse", "g1", self(), @lease_policy, name)
      [a] = queued(name, "l-refuse", 1)
      {:ok, offer} = DeliveryStates.queue_offer("l-refuse", "g1", self(), :root, name)

      assert DeliveryStates.queue_begin_native(
               "l-refuse",
               "g0",
               self(),
               offer.lease_id,
               [a],
               name
             ) ==
               {:error, :stale_delivery_owner}

      assert DeliveryStates.queue_begin_native(
               "l-refuse",
               "g1",
               self(),
               offer.lease_id + 1,
               [a],
               name
             ) ==
               {:error, :unknown_lease}
    end
  end

  describe "queue control" do
    @control_policy %{batch_max_items: 10, backlog_max_items: 10, backlog_max_bytes: 1_000}

    setup %{name: name} do
      recipient = "ctl-#{System.unique_integer([:positive])}"
      {:ok, _} = DeliveryStates.bind_queue(recipient, "g1", self(), @control_policy, name)
      counter = :counters.new(1, [])
      %{recipient: recipient, counter: counter}
    end

    defp control(ctx, request, id \\ nil) do
      id =
        id ||
          (
            :counters.add(ctx.counter, 1, 1)
            Integer.to_string(:counters.get(ctx.counter, 1))
          )

      {id, DeliveryStates.queue_control(ctx.recipient, "g1", self(), id, request, ctx.name)}
    end

    defp put(ctx, sender, opts \\ []) do
      {:ok, token, _} = DeliveryStates.queue_reserve(ctx.recipient, :ordinary, 3, ctx.name)

      {:ok, id} =
        DeliveryStates.queue_commit(
          ctx.recipient,
          token,
          %{
            sender: sender,
            conversation_id: "c-" <> sender,
            turn_number: 1,
            kind: "inform",
            early: Keyword.get(opts, :early, false)
          },
          %{"type" => "inter_agent_message", "from" => sender},
          ctx.name
        )

      id
    end

    defp root_credit(token \\ "t1"), do: %{op: :credit, kind: :root, token: token}

    test "root credit pushes a batch to the owner", ctx do
      a = put(ctx, "a")

      assert {_, {:ok, %{credit_revision: "1", queue: %{queued: 1}}}} =
               control(ctx, root_credit())

      assert_receive {:inter_agent_queue_batch, batch}
      assert %{"kind" => "root", "credit_revision" => "1", "version" => "0"} = batch

      assert [%{"queue_id" => queue_id, "delivery_seq" => 1, "envelope" => %{"from" => "a"}}] =
               batch["items"]

      assert queue_id == Integer.to_string(a)
    end

    test "an outstanding credit is served when input arrives", ctx do
      {_, {:ok, _}} = control(ctx, root_credit())
      refute_received {:inter_agent_queue_batch, _}
      put(ctx, "a")
      assert_receive {:inter_agent_queue_batch, %{"items" => [_]}}
    end

    test "a credit retry replays until the credit is consumed", ctx do
      request = root_credit()
      {id, {:ok, first}} = control(ctx, request)
      assert {_, {:ok, ^first}} = control(ctx, request, id)

      put(ctx, "a")
      assert_receive {:inter_agent_queue_batch, _}
      assert {_, {:error, :unknown_operation}} = control(ctx, request, id)
    end

    test "begin_native is bound to the lease's turn, replays, then supersedes", ctx do
      a = put(ctx, "a")
      b = put(ctx, "a")
      {_, {:ok, _}} = control(ctx, root_credit("turn-1"))
      assert_receive {:inter_agent_queue_batch, %{"lease_id" => lease}}
      lease = String.to_integer(lease)

      begin = %{op: :begin_native, lease_id: lease, queue_ids: [a, b], token: "turn-2"}

      assert {_, {:error, {:invalid_queue_control, "native_turn_token"}}} = control(ctx, begin)

      begin = %{begin | token: "turn-1"}
      {id, {:ok, %{permitted_queue_ids: [^a, ^b]}}} = control(ctx, begin)
      assert {_, {:ok, %{permitted_queue_ids: [^a, ^b]}}} = control(ctx, begin, id)

      assert {_, {:error, :operation_payload_mismatch}} =
               control(ctx, %{begin | queue_ids: [a]}, id)

      {_, {:ok, _}} = control(ctx, %{op: :dispose, lease_id: lease, items: [{a, :observed}]})

      assert {_, {:error, {:operation_superseded, [{^a, :terminal}, {^b, :native_pending}]}}} =
               control(ctx, begin, id)

      {_, {:ok, _}} = control(ctx, %{op: :dispose, lease_id: lease, items: [{b, :unknown}]})
      assert {_, {:error, :unknown_operation}} = control(ctx, begin, id)
    end

    test "root credit is refused while a previous root is native-pending", ctx do
      a = put(ctx, "a")
      {_, {:ok, _}} = control(ctx, root_credit("turn-1"))
      assert_receive {:inter_agent_queue_batch, %{"lease_id" => lease}}
      lease = String.to_integer(lease)

      {_, {:ok, _}} =
        control(ctx, %{op: :begin_native, lease_id: lease, queue_ids: [a], token: "turn-1"})

      assert {_, {:error, :previous_root_pending}} = control(ctx, root_credit("turn-2"))

      {_, {:ok, _}} = control(ctx, %{op: :dispose, lease_id: lease, items: [{a, :unknown}]})
      assert {_, {:ok, _}} = control(ctx, root_credit("turn-2"))
    end

    test "freeze withdraws the credit and stops every later batch", ctx do
      {_, {:ok, %{credit_revision: revision}}} = control(ctx, root_credit())
      assert {_, {:ok, %{frozen: true}}} = control(ctx, %{op: :freeze, reason: :shutdown})
      assert {_, {:ok, %{withdrawn: false}}} = control(ctx, %{op: :withdraw, revision: revision})
      put(ctx, "a")
      refute_received {:inter_agent_queue_batch, _}
      assert {_, {:error, :queue_frozen}} = control(ctx, root_credit())
    end

    test "a same-generation rejoin with a lease must resume before new credit", ctx do
      a = put(ctx, "a")
      {_, {:ok, _}} = control(ctx, root_credit())
      assert_receive {:inter_agent_queue_batch, %{"lease_id" => lease}}
      lease = String.to_integer(lease)

      {:ok, _} = DeliveryStates.bind_queue(ctx.recipient, "g1", self(), @control_policy, ctx.name)
      assert DeliveryStates.queue_resume_required?(ctx.recipient, ctx.name)
      assert {_, {:error, :queue_resume_required}} = control(ctx, root_credit())

      assert {_,
              {:ok, %{leases: [%{lease_id: ^lease, items: [%{queue_id: ^a, phase: :offered}]}]}}} =
               control(ctx, %{op: :resume, lease_ids: [lease], registration_ids: []})

      refute DeliveryStates.queue_resume_required?(ctx.recipient, ctx.name)
    end

    test "a declined early item keeps the early credit for the next one (B4)", ctx do
      e1 = put(ctx, "a", early: true)
      e2 = put(ctx, "b", early: true)

      {_, {:ok, _}} =
        control(ctx, %{op: :credit, kind: :early, token: "turn-1", mechanism: :fold})

      assert_receive {:inter_agent_queue_batch,
                      %{"lease_id" => lease, "items" => [%{"queue_id" => first}]}}

      assert first == Integer.to_string(e1)

      {_, {:ok, _}} =
        control(ctx, %{
          op: :return,
          lease_id: String.to_integer(lease),
          items: [{e1, :early_ineligible}]
        })

      assert_receive {:inter_agent_queue_batch, %{"items" => [%{"queue_id" => second}]}}
      assert second == Integer.to_string(e2)
    end

    test "a superseding credit waits for the offered lease", ctx do
      a = put(ctx, "a")
      put(ctx, "b")
      {_, {:ok, _}} = control(ctx, root_credit("turn-1"))
      assert_receive {:inter_agent_queue_batch, %{"lease_id" => lease}}

      {_, {:ok, _}} = control(ctx, root_credit("turn-1b"))
      refute_received {:inter_agent_queue_batch, _}

      {_, {:ok, _}} =
        control(ctx, %{
          op: :begin_native,
          lease_id: String.to_integer(lease),
          queue_ids: [a],
          token: "turn-1"
        })

      {_, {:ok, _}} =
        control(ctx, %{op: :credit, kind: :early, token: "turn-1b", mechanism: :fold})

      refute_received {:inter_agent_queue_batch, _}
    end

    test "withdraw revokes only the outstanding revision", ctx do
      {_, {:ok, %{credit_revision: revision}}} = control(ctx, root_credit())
      assert {_, {:ok, %{withdrawn: false}}} = control(ctx, %{op: :withdraw, revision: "99"})
      assert {_, {:ok, %{withdrawn: true}}} = control(ctx, %{op: :withdraw, revision: revision})
      put(ctx, "a")
      refute_received {:inter_agent_queue_batch, _}
    end

    test "a stale owner or a malformed id is refused", ctx do
      assert DeliveryStates.queue_control(
               ctx.recipient,
               "g1",
               spawn(fn -> :ok end),
               "1",
               root_credit(),
               ctx.name
             ) ==
               {:error, :stale_delivery_owner}

      assert DeliveryStates.queue_control(
               ctx.recipient,
               "g1",
               self(),
               "01",
               root_credit(),
               ctx.name
             ) ==
               {:error, {:invalid_queue_control, "operation_id"}}
    end
  end

  describe "queue-origin sequences in resync and retirement" do
    @resync_policy %{batch_max_items: 1, backlog_max_items: 10, backlog_max_bytes: 1_000}

    setup %{name: name} do
      recipient = "rs-#{System.unique_integer([:positive])}"
      {:ok, _} = DeliveryStates.bind_queue(recipient, "g1", self(), @resync_policy, name)

      ids =
        for n <- 1..3 do
          {:ok, token, _} = DeliveryStates.queue_reserve(recipient, :ordinary, 2, name)

          {:ok, id} =
            DeliveryStates.queue_commit(
              recipient,
              token,
              %{sender: "s", conversation_id: "c", turn_number: n, kind: "inform"},
              %{"n" => n},
              name
            )

          id
        end

      # One native-pending (seq 1) and one offered (seq 2) item; the third stays queued.
      {:ok, first} = DeliveryStates.queue_offer(recipient, "g1", self(), :root, name)

      {:ok, _} =
        DeliveryStates.queue_begin_native(
          recipient,
          "g1",
          self(),
          first.lease_id,
          [hd(ids)],
          name
        )

      {:ok, _second} = DeliveryStates.queue_offer(recipient, "g1", self(), :root, name)
      %{recipient: recipient, ids: ids}
    end

    test "a resync gap returns offers and resolves native-pending without a loss", ctx do
      [pending, offered, waiting] = ctx.ids

      assert {:ok, status, %{returned: [[2, 2]], uncertain: [[1, 1]], skipped: []}} =
               DeliveryStates.resync_detailed(
                 :resync,
                 ctx.recipient,
                 "g1",
                 self(),
                 2,
                 [[1, 2]],
                 ctx.name
               )

      assert %{acked_seq: 2, lost_count: 0, uncertain_count: 1} = status
      assert DeliveryStates.pending_losses(ctx.name) == []

      counts = DeliveryStates.queue_counts(ctx.recipient, ctx.name)
      assert %{queued: 2, offered: 0, native_pending: 0} = counts
      bodies = :sys.get_state(ctx.name).bodies
      refute Map.has_key?(bodies, {ctx.recipient, pending})
      assert Map.has_key?(bodies, {ctx.recipient, offered})
      assert Map.has_key?(bodies, {ctx.recipient, waiting})
    end

    test "the plain resync API keeps its shape", ctx do
      assert {:ok, %{acked_seq: 2}} =
               DeliveryStates.resync(ctx.recipient, "g1", self(), 2, [[1, 2]], ctx.name)
    end

    test "resync waits for resume after a same-generation rejoin", ctx do
      {:ok, _} = DeliveryStates.bind_queue(ctx.recipient, "g1", self(), @resync_policy, ctx.name)

      assert DeliveryStates.resync(ctx.recipient, "g1", self(), 2, [[1, 2]], ctx.name) ==
               {:error, :queue_resume_required}
    end

    test "retiring a generation keeps the queue and records no queue loss", ctx do
      [_pending, offered, waiting] = ctx.ids

      assert {:ok, %{acked_seq: 2, lost_count: 0, uncertain_count: 1}} =
               DeliveryStates.retire_owned_generation(ctx.recipient, "g1", self(), ctx.name)

      assert DeliveryStates.pending_losses(ctx.name) == []
      queue = :sys.get_state(ctx.name).entries[ctx.recipient].queue
      assert queue.items[offered].phase == :queued
      assert queue.items[offered].last_return_reason == :shutdown
      assert queue.items[waiting].phase == :queued
    end
  end

  describe "stale-basis recovery claim" do
    setup %{name: name} do
      recipient = "rc-#{System.unique_integer([:positive])}"

      {:ok, _} =
        DeliveryStates.bind_queue(
          recipient,
          "g1",
          self(),
          %{batch_max_items: 10, backlog_max_items: 20, backlog_max_bytes: 100_000},
          name
        )

      put = fn sender, cid, bytes ->
        {:ok, token, _} = DeliveryStates.queue_reserve(recipient, :ordinary, bytes, name)

        {:ok, id} =
          DeliveryStates.queue_commit(
            recipient,
            token,
            %{sender: sender, conversation_id: cid, turn_number: 1, kind: "inform"},
            %{"cid" => cid},
            name
          )

        id
      end

      %{recipient: recipient, put: put}
    end

    defp claimed(ctx, peer, cid) do
      case DeliveryStates.queue_claim_recovery(ctx.recipient, "g1", self(), peer, cid, ctx.name) do
        nil -> nil
        %{"items" => items} -> Enum.map(items, &String.to_integer(&1["queue_id"]))
      end
    end

    test "claims that peer's input on that conversation, oldest first, within 10 items", ctx do
      # Older input of another conversation or another peer is not claimed.
      _other_cid = ctx.put.("p", "other", 10)
      _other_peer = ctx.put.("q", "c", 10)
      ids = for _ <- 1..11, do: ctx.put.("p", "c", 10)

      assert claimed(ctx, "p", "c") == Enum.take(ids, 10)
      assert %{offered: 10} = DeliveryStates.queue_counts(ctx.recipient, ctx.name)
    end

    test "stops at 16384 bytes of body charge", ctx do
      first = ctx.put.("p", "c", 10_000)
      _second = ctx.put.("p", "c", 6_385)
      assert claimed(ctx, "p", "c") == [first]
    end

    test "claims nothing while the lease slot is held", ctx do
      ctx.put.("p", "c", 10)
      {:ok, _offer} = DeliveryStates.queue_offer(ctx.recipient, "g1", self(), :root, ctx.name)
      ctx.put.("p", "c", 10)
      assert claimed(ctx, "p", "c") == nil
    end
  end

  describe "waiter matching" do
    test "a reply matches only the registered peer", %{name: name} do
      policy = %{batch_max_items: 10, backlog_max_items: 10, backlog_max_bytes: 1_000}
      {:ok, _} = DeliveryStates.bind_queue("wm", "g1", self(), policy, name)

      {:ok, _id} =
        DeliveryStates.queue_register_waiter(
          "wm",
          "g1",
          self(),
          %{peer: "p", cid: "c", turn: 1, token: "t", call_token: "ct", expires_in_ms: 60_000},
          name
        )

      assert {:ok, _token, :ordinary} =
               DeliveryStates.queue_reserve_reply("wm", "q", "c", 1, name)

      assert {:ok, _token, :ordinary} =
               DeliveryStates.queue_reserve_reply("wm", "p", "other", 1, name)

      assert {:ok, token, :waiter} = DeliveryStates.queue_reserve_reply("wm", "p", "c", 1, name)

      # Claimed: a second reply on the same route is ordinary, until a cancel restores it.
      assert {:ok, _token, :ordinary} =
               DeliveryStates.queue_reserve_reply("wm", "p", "c", 1, name)

      :ok = DeliveryStates.queue_cancel(token, name)
      assert {:ok, _token, :waiter} = DeliveryStates.queue_reserve_reply("wm", "p", "c", 1, name)
    end
  end

  describe "queue schema on load" do
    test "an unsupported queue record stops the owner and stays on disk", %{
      name: name,
      path: path
    } do
      policy = %{batch_max_items: 10, backlog_max_items: 10, backlog_max_bytes: 1_000}
      {:ok, _} = DeliveryStates.bind_queue("schema", "g1", self(), policy, name)
      GenServer.stop(Process.whereis(name))

      [{"schema", generation, issued, acked, pending, recovery}] =
        raw(name, path, &:dets.lookup(&1, "schema"))

      broken = put_in(recovery, [:queue, :version], 99)

      raw(name, path, fn table ->
        :ok = :dets.insert(table, {"schema", generation, issued, acked, pending, broken})
      end)

      Process.flag(:trap_exit, true)
      assert {:error, {%ArgumentError{}, _}} = DeliveryStates.start_link(name: name, path: path)

      assert [{"schema", _, _, _, _, %{queue: %{version: 99}}}] =
               raw(name, path, &:dets.lookup(&1, "schema"))
    end
  end
end
