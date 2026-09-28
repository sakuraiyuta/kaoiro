defmodule KaoiroServer.WorkStoreTest do
  use ExUnit.Case, async: false
  import KaoiroServer.TestTeardown

  alias KaoiroServer.PersistencePaths
  alias KaoiroServer.WorkStore

  test "default application composition persists the first grant and receipt" do
    manifest = Enum.find(PersistencePaths.manifest(), &(&1.store == "work_store"))
    assert manifest.env == "KAOIRO_WORK_STORE_PATH"
    assert manifest.default_file == "work_store.dets"
    assert WorkStore in Enum.map(Supervisor.which_children(KaoiroServer.Supervisor), &elem(&1, 0))

    path = Application.fetch_env!(:kaoiro_server, :work_store_path)
    assert :sys.get_state(WorkStore).path == path
    assert :sys.get_state(WorkStore).test_after_apply_sync == nil

    principal = %{"kind" => "user", "id" => "default-composition"}

    operation_id =
      "op_#{System.system_time(:millisecond)}_#{Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)}"

    operation = %{
      "op" => "assign",
      "operation_id" => operation_id,
      "title" => "Default store path",
      "assignee" => "default-composition-agent",
      "director" => principal,
      "requires_verdict" => false
    }

    assert {:ok, %{work: %{work_id: work_id}}} =
             WorkStore.apply(principal, operation, %{operator: true})

    assert File.exists?(path)
    assert {:ok, %{operation_id: ^operation_id}} = WorkStore.op_result(principal, operation_id)

    assert :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, WorkStore)
    {:ok, _pid} = Supervisor.restart_child(KaoiroServer.Supervisor, WorkStore)

    assert {:ok, %{operation_id: ^operation_id}} = WorkStore.op_result(principal, operation_id)

    assert {:ok, %{work: %{work_id: ^work_id, state: "active", revision: 1}}} =
             WorkStore.status(principal, work_id)
  end

  test "work store path is derived by runtime and deployment generators" do
    entry = Enum.find(PersistencePaths.manifest(), &(&1.store == "work_store"))
    assert entry.env == "KAOIRO_WORK_STORE_PATH"
    runtime = File.read!(Path.expand("../../config/runtime.exs", __DIR__))
    generator = File.read!(Path.expand("../../lib/mix/tasks/kaoiro.env.ex", __DIR__))
    assert runtime =~ "for store <- KaoiroServer.PersistencePaths.stores() do"
    assert generator =~ "Enum.map(PersistencePaths.stores(), fn store ->"
    refute runtime =~ "System.get_env(\"KAOIRO_WORK_STORE_PATH\")"
    refute generator =~ "#KAOIRO_WORK_STORE_PATH="
  end

  test "serialized claims share one recipient interval across works" do
    name = :"work_store_claim_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
    File.rm(path)
    {:ok, _} = WorkStore.start_link(name: name, path: path)

    on_exit(fn ->
      stop_quietly(name)
      File.rm(path)
    end)

    recipient = %{"kind" => "agent", "id" => "claim-recipient"}
    work1 = active_work(name, "claim-director-1", recipient, "claim-cid-1")
    work2 = active_work(name, "claim-director-2", recipient, "claim-cid-2")

    assert {:ok, first} =
             WorkStore.admit_yield(
               %{"kind" => "agent", "id" => "claim-director-1"},
               recipient["id"],
               "claim-cid-1",
               3,
               work1.work_id,
               work1.authority_epoch,
               name
             )

    assert {:ok, second} =
             WorkStore.admit_yield(
               %{"kind" => "agent", "id" => "claim-director-2"},
               recipient["id"],
               "claim-cid-2",
               3,
               work2.work_id,
               work2.authority_epoch,
               name
             )

    first_request = claim_request(first, "claim-cid-1", work1)
    second_request = claim_request(second, "claim-cid-2", work2)

    tasks =
      for request <- [first_request, second_request] do
        Task.async(fn -> WorkStore.claim(recipient, request, name) end)
      end

    decisions = Enum.map(tasks, &Task.await/1)
    assert Enum.count(decisions, &(&1 == {:ok, %{granted: true}})) == 1

    assert Enum.count(decisions, &match?({:ok, %{granted: false, reason: :yield_interval}}, &1)) ==
             1

    granted_request =
      if hd(decisions) == {:ok, %{granted: true}}, do: first_request, else: second_request

    claimed = :sys.get_state(name)
    claimed_at = claimed.yield_tokens[granted_request["yield_token"]].claimed_at_ms
    last_claim = claimed.yield_last[recipient["id"]]

    assert {:ok, %{granted: true, repeated: true}} =
             WorkStore.claim(recipient, granted_request, name)

    repeated = :sys.get_state(name)
    assert repeated.yield_tokens[granted_request["yield_token"]].claimed_at_ms == claimed_at
    assert repeated.yield_last[recipient["id"]] == last_claim
  end

  test "V6 one yield claim repeats without consuming another grant" do
    previous = Application.fetch_env!(:kaoiro_server, :delivery_intent)

    Application.put_env(
      :kaoiro_server,
      :delivery_intent,
      Keyword.put(previous, :yield_min_interval_ms, 0)
    )

    on_exit(fn -> Application.put_env(:kaoiro_server, :delivery_intent, previous) end)

    with_store("claim_repeat", fn name ->
      recipient = %{"kind" => "agent", "id" => "claim-repeat-recipient"}
      work = active_work(name, "claim-repeat-director", recipient, "claim-repeat-cid")

      assert {:ok, token} =
               WorkStore.admit_yield(
                 %{"kind" => "agent", "id" => "claim-repeat-director"},
                 recipient["id"],
                 "claim-repeat-cid",
                 3,
                 work.work_id,
                 work.authority_epoch,
                 name
               )

      request = claim_request(token, "claim-repeat-cid", work)
      assert {:ok, %{granted: true}} = WorkStore.claim(recipient, request, name)
      first = :sys.get_state(name)

      assert {:ok, %{granted: true, repeated: true}} =
               WorkStore.claim(recipient, request, name)

      second = :sys.get_state(name)

      assert first.yield_tokens[token.yield_token].claimed_at_ms ==
               second.yield_tokens[token.yield_token].claimed_at_ms

      assert first.yield_last[recipient["id"]] == second.yield_last[recipient["id"]]
    end)
  end

  test "recipient token cap covers all of its works" do
    with_store("recipient_cap", fn name ->
      recipient = %{"kind" => "agent", "id" => "cap-recipient"}

      works = [
        active_work(name, "cap-director-a", recipient, "cap-cid-a"),
        active_work(name, "cap-director-b", recipient, "cap-cid-b")
      ]

      for i <- 1..64 do
        work = Enum.at(works, rem(i, 2))
        director = if rem(i, 2) == 0, do: "cap-director-a", else: "cap-director-b"
        cid = if rem(i, 2) == 0, do: "cap-cid-a", else: "cap-cid-b"

        assert {:ok, _token} =
                 WorkStore.admit_yield(
                   %{"kind" => "agent", "id" => director},
                   recipient["id"],
                   cid,
                   i + 2,
                   work.work_id,
                   work.authority_epoch,
                   name
                 )
      end

      assert {:error, :yield_capacity} =
               WorkStore.admit_yield(
                 %{"kind" => "agent", "id" => "cap-director-a"},
                 recipient["id"],
                 "cap-cid-a",
                 67,
                 hd(works).work_id,
                 hd(works).authority_epoch,
                 name
               )

      assert map_size(:sys.get_state(name).claim_states[recipient["id"]].tokens) == 64
    end)
  end

  test "expired orphan and claimed tokens are swept on restart without resetting the interval" do
    with_store("yield_expiry", fn name ->
      recipient = %{"kind" => "agent", "id" => "expiry-recipient"}
      director = %{"kind" => "agent", "id" => "expiry-director"}
      cid = "expiry-cid"
      work = active_work(name, director["id"], recipient, cid)

      issue = fn turn ->
        WorkStore.admit_yield(
          director,
          recipient["id"],
          cid,
          turn,
          work.work_id,
          work.authority_epoch,
          name
        )
      end

      assert {:ok, claimed} = issue.(3)
      assert {:ok, orphan} = issue.(4)

      assert {:ok, %{granted: true}} =
               WorkStore.claim(recipient, claim_request(claimed, cid, work), name)

      path = :sys.get_state(name).path
      GenServer.stop(name)
      {:ok, _} = WorkStore.start_link(name: name, path: path)
      assert {:error, :yield_interval} = issue.(5)

      state = :sys.get_state(name)
      claim = state.claim_states[recipient["id"]]

      expired = %{
        claim
        | tokens:
            claim.tokens
            |> Map.update!(claimed.yield_token, &%{&1 | claimed_at_ms: 0})
            |> Map.update!(orphan.yield_token, &%{&1 | expires_at_ms: 0})
      }

      assert :ok = :dets.insert(name, {{:yield_state, recipient["id"]}, expired})
      assert :ok = :dets.sync(name)
      GenServer.stop(name)
      {:ok, _} = WorkStore.start_link(name: name, path: path)

      assert :sys.get_state(name).claim_states[recipient["id"]].tokens == %{}
      assert :sys.get_state(name).yield_last[recipient["id"]] == claim.last_claim_at

      assert {:ok, %{granted: false, reason: :unknown_yield}} =
               WorkStore.claim(recipient, claim_request(claimed, cid, work), name)

      assert {:error, :yield_interval} = issue.(5)
    end)
  end

  test "transfer reports a claim that committed before its epoch change" do
    name = :"work_store_transfer_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
    File.rm(path)
    {:ok, _} = WorkStore.start_link(name: name, path: path)

    on_exit(fn ->
      stop_quietly(name)
      File.rm(path)
    end)

    recipient = %{"kind" => "agent", "id" => "transfer-recipient"}
    work = active_work(name, "transfer-director", recipient, "transfer-cid")

    assert {:ok, token} =
             WorkStore.admit_yield(
               %{"kind" => "agent", "id" => "transfer-director"},
               recipient["id"],
               "transfer-cid",
               3,
               work.work_id,
               work.authority_epoch,
               name
             )

    assert {:ok, %{granted: true}} =
             WorkStore.claim(recipient, claim_request(token, "transfer-cid", work), name)

    operator = %{"kind" => "user", "id" => "transfer-operator"}

    assert {:ok, %{claimed_yield_tokens: [claimed]}} =
             WorkStore.apply(
               operator,
               %{
                 "op" => "transfer",
                 "operation_id" => operation_id(),
                 "work_id" => work.work_id,
                 "expected_revision" => work.revision,
                 "assignee" => "next-assignee"
               },
               %{operator: true},
               name
             )

    assert claimed == token.yield_token

    assert {:ok, %{granted: true, repeated: true}} =
             WorkStore.claim(recipient, claim_request(token, "transfer-cid", work), name)
  end

  test "V5 claim refuses a token from an earlier authority epoch" do
    with_store("claim_epoch", fn name ->
      recipient = %{"kind" => "agent", "id" => "claim-epoch-recipient"}
      work = active_work(name, "claim-epoch-director", recipient, "claim-epoch-cid")
      director = %{"kind" => "agent", "id" => "claim-epoch-director"}
      operator = %{"kind" => "user", "id" => "claim-epoch-operator"}

      assert {:ok, token} =
               WorkStore.admit_yield(
                 director,
                 recipient["id"],
                 "claim-epoch-cid",
                 3,
                 work.work_id,
                 work.authority_epoch,
                 name
               )

      for {revision, next_director} <- [{1, "temporary-director"}, {2, director["id"]}] do
        assert {:ok, _} =
                 WorkStore.apply(
                   operator,
                   %{
                     "op" => "transfer",
                     "operation_id" => operation_id(),
                     "work_id" => work.work_id,
                     "expected_revision" => revision,
                     "director" => %{"kind" => "agent", "id" => next_director}
                   },
                   %{operator: true},
                   name
                 )
      end

      assert {:ok, %{granted: false, reason: :grant_changed}} =
               WorkStore.claim(recipient, claim_request(token, "claim-epoch-cid", work), name)

      assert :sys.get_state(name).yield_tokens[token.yield_token].state == "unclaimed"
    end)
  end

  test "work revision and its yield token survive one apply and rejection cleanup" do
    name = :"work_store_joint_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
    File.rm(path)
    {:ok, _} = WorkStore.start_link(name: name, path: path)

    on_exit(fn ->
      stop_quietly(name)
      File.rm(path)
    end)

    recipient = %{"kind" => "agent", "id" => "joint-recipient"}
    director = %{"kind" => "agent", "id" => "joint-director"}
    work = active_work(name, director["id"], recipient, "joint-cid")
    operation_id = operation_id()

    request = %{
      recipient: recipient["id"],
      conversation_id: "joint-cid",
      turn_number: 3,
      work_id: work.work_id,
      epoch: work.authority_epoch
    }

    operation = %{
      "op" => "revise",
      "operation_id" => operation_id,
      "work_id" => work.work_id,
      "expected_revision" => work.revision
    }

    context = %{
      recipient: recipient["id"],
      conversation_id: "joint-cid",
      turn_number: 3,
      new_conversation?: false,
      yield_request: request
    }

    assert {:ok, %{work: %{revision: 2}}, {:ok, token}} =
             WorkStore.apply(director, operation, context, name)

    assert :sys.get_state(name).yield_tokens[token.yield_token].work_id == work.work_id

    GenServer.stop(name)
    {:ok, _} = WorkStore.start_link(name: name, path: path)
    assert :sys.get_state(name).yield_tokens[token.yield_token].work_id == work.work_id
    assert {:ok, %{work: %{revision: 2}}} = WorkStore.status(director, work.work_id, name)

    assert :ok =
             WorkStore.note_delivery(
               director,
               operation_id,
               %{status: "not_recorded", reason: "stale_turn"},
               token.yield_token,
               name
             )

    refute Map.has_key?(:sys.get_state(name).yield_tokens, token.yield_token)

    assert {:ok, %{delivery: %{status: "not_recorded"}}} =
             WorkStore.op_result(director, operation_id, name)
  end

  test "work receipt precedes one recipient token write, and claim uses one object" do
    with_store("claim_object", fn name ->
      recipient = %{"kind" => "agent", "id" => "claim-object-recipient"}
      director = %{"kind" => "agent", "id" => "claim-object-director"}
      work = active_work(name, director["id"], recipient, "claim-object-cid")
      pid = Process.whereis(name)
      parent = self()

      tracer =
        spawn(fn ->
          for _ <- 1..3 do
            receive do
              event -> send(parent, {:work_dets_trace, event})
            end
          end
        end)

      :erlang.trace_pattern({:dets, :insert, 2}, true, [])
      :erlang.trace(pid, true, [:call, {:tracer, tracer}])

      try do
        request = %{
          recipient: recipient["id"],
          conversation_id: "claim-object-cid",
          turn_number: 3,
          work_id: work.work_id,
          epoch: work.authority_epoch
        }

        assert {:ok, %{work: %{revision: 2}}, {:ok, token}} =
                 WorkStore.apply(
                   director,
                   %{
                     "op" => "revise",
                     "operation_id" => operation_id(),
                     "work_id" => work.work_id,
                     "expected_revision" => work.revision
                   },
                   %{
                     recipient: recipient["id"],
                     conversation_id: "claim-object-cid",
                     yield_request: request
                   },
                   name
                 )

        assert_receive {:work_dets_trace, {:trace, ^pid, :call, {:dets, :insert, [^name, first]}}}

        assert_receive {:work_dets_trace,
                        {:trace, ^pid, :call, {:dets, :insert, [^name, second]}}}

        assert match?({{:work, _}, _}, first)
        assert match?({{:yield_state, "claim-object-recipient"}, _}, second)
        refute is_list(first)
        refute is_list(second)

        assert {:ok, %{granted: true}} =
                 WorkStore.claim(recipient, claim_request(token, "claim-object-cid", work), name)

        assert_receive {:work_dets_trace, {:trace, ^pid, :call, {:dets, :insert, [^name, third]}}}

        assert match?({{:yield_state, "claim-object-recipient"}, _}, third)
        refute is_list(third)

        assert [{{:yield_state, recipient_id}, claim}] =
                 :dets.lookup(name, {:yield_state, recipient["id"]})

        assert recipient_id == recipient["id"]
        assert claim.last_claim_at == claim.tokens[token.yield_token].claimed_at_ms

        path = :sys.get_state(name).path
        GenServer.stop(name)
        {:ok, _} = WorkStore.start_link(name: name, path: path)

        assert {:ok, %{granted: true, repeated: true}} =
                 WorkStore.claim(recipient, claim_request(token, "claim-object-cid", work), name)
      after
        if Process.alive?(pid), do: :erlang.trace(pid, false, [:call])
        :erlang.trace_pattern({:dets, :insert, 2}, false, [])
      end
    end)
  end

  test "op receipt survives unavailable token write with a distinct downgrade" do
    name = :"work_store_token_failure_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
    File.rm(path)
    table_path = String.to_charlist(path)
    armed = :atomics.new(1, [])

    after_sync = fn ->
      if :atomics.get(armed, 1) == 1 do
        :ok = :dets.close(name)
        {:ok, ^name} = :dets.open_file(name, file: table_path, access: :read)
      end
    end

    {:ok, _} = WorkStore.start_link(name: name, path: path, test_after_apply_sync: after_sync)

    on_exit(fn ->
      stop_quietly(name)
      File.rm(path)
    end)

    recipient = %{"kind" => "agent", "id" => "token-failure-recipient"}
    director = %{"kind" => "agent", "id" => "token-failure-director"}
    work = active_work(name, director["id"], recipient, "token-failure-cid")
    op_id = operation_id()
    :atomics.put(armed, 1, 1)

    request = %{
      recipient: recipient["id"],
      conversation_id: "token-failure-cid",
      turn_number: 3,
      work_id: work.work_id,
      epoch: work.authority_epoch
    }

    assert {:ok, %{work: %{revision: 2}}, {:error, :yield_token_unavailable}} =
             WorkStore.apply(
               director,
               %{
                 "op" => "revise",
                 "operation_id" => op_id,
                 "work_id" => work.work_id,
                 "expected_revision" => work.revision
               },
               %{
                 recipient: recipient["id"],
                 conversation_id: "token-failure-cid",
                 yield_request: request
               },
               name
             )

    assert {:ok, %{operation_id: ^op_id}} = WorkStore.op_result(director, op_id, name)
    assert :sys.get_state(name).yield_tokens == %{}
    GenServer.stop(name)
    {:ok, _} = WorkStore.start_link(name: name, path: path)
    assert {:ok, %{operation_id: ^op_id}} = WorkStore.op_result(director, op_id, name)
    assert {:ok, %{work: %{revision: 2}}} = WorkStore.status(director, work.work_id, name)
  end

  test "V10 and V12: stale revision and wrong actor cannot revise" do
    with_store("revision", fn name ->
      assignee = %{"kind" => "agent", "id" => "revision-assignee"}
      director = %{"kind" => "agent", "id" => "revision-director"}
      work = active_work(name, director["id"], assignee, "revision-cid")

      revise = %{
        "op" => "revise",
        "work_id" => work.work_id,
        "expected_revision" => work.revision
      }

      assert {:error, :work_not_authorized} =
               WorkStore.apply(
                 assignee,
                 Map.put(revise, "operation_id", operation_id()),
                 %{recipient: director["id"], conversation_id: "revision-cid"},
                 name
               )

      assert {:ok, %{work: %{revision: 2}}} =
               WorkStore.apply(
                 director,
                 Map.put(revise, "operation_id", operation_id()),
                 %{recipient: assignee["id"], conversation_id: "revision-cid"},
                 name
               )

      assert {:error, :stale_work_revision} =
               WorkStore.apply(
                 director,
                 Map.put(revise, "operation_id", operation_id()),
                 %{recipient: assignee["id"], conversation_id: "revision-cid"},
                 name
               )
    end)
  end

  test "V21 expired operation identity cannot create a work" do
    with_store("expired_identity", fn name ->
      operator = %{"kind" => "user", "id" => "expired-operator"}
      old = "op_0_" <> Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)

      assert {:error, :operation_id_expired} =
               WorkStore.apply(
                 operator,
                 %{
                   "op" => "assign",
                   "operation_id" => old,
                   "title" => "Expired operation",
                   "director" => operator,
                   "assignee" => "expired-assignee"
                 },
                 %{operator: true},
                 name
               )

      assert WorkStore.all(name) == %{}
    end)
  end

  test "V36a and V36b nomination cap and expiry" do
    with_store("nomination_bounds", fn name ->
      director = %{"kind" => "agent", "id" => "nomination-director"}

      nominations =
        for i <- 1..16 do
          assert {:ok, %{work: work}} =
                   WorkStore.apply(
                     director,
                     %{
                       "op" => "assign",
                       "operation_id" => operation_id(),
                       "title" => "Nomination #{i}"
                     },
                     %{
                       recipient: "nominee-#{i}",
                       conversation_id: "nomination-cid-#{i}",
                       turn_number: 1,
                       new_conversation?: true
                     },
                     name
                   )

          work
        end

      assert {:error, :work_capacity} =
               WorkStore.apply(
                 director,
                 %{
                   "op" => "assign",
                   "operation_id" => operation_id(),
                   "title" => "Nomination 17"
                 },
                 %{
                   recipient: "nominee-17",
                   conversation_id: "nomination-cid-17",
                   turn_number: 1,
                   new_conversation?: true
                 },
                 name
               )

      assert map_size(WorkStore.all(name)) == 16

      first = hd(nominations)

      :sys.replace_state(name, fn state ->
        old = %{state.works[first.work_id] | updated_at: "2020-01-01T00:00:00Z"}
        %{state | works: Map.put(state.works, first.work_id, old)}
      end)

      assert :ok = WorkStore.sweep(name)

      assert {:ok, %{work: %{state: "expired"}}} =
               WorkStore.status(director, first.work_id, name)
    end)
  end

  test "V37 work revision epoch holds transfer obligation and receipt survive restart" do
    with_store("all_durable_fields", fn name ->
      operator = %{"kind" => "user", "id" => "durable-operator"}
      director = %{"kind" => "agent", "id" => "durable-director"}
      first_assignee = %{"kind" => "agent", "id" => "durable-first-assignee"}
      work = active_work(name, director["id"], first_assignee, "durable-cid")
      hold_operation_id = operation_id()

      assert {:ok, %{work: %{revision: 2}}} =
               WorkStore.apply(
                 director,
                 %{
                   "op" => "hold",
                   "operation_id" => hold_operation_id,
                   "work_id" => work.work_id,
                   "expected_revision" => 1,
                   "reason" => "await review"
                 },
                 %{recipient: first_assignee["id"], conversation_id: "durable-cid"},
                 name
               )

      assert {:ok, %{work: %{revision: 3, authority_epoch: 2}}} =
               WorkStore.apply(
                 operator,
                 %{
                   "op" => "transfer",
                   "operation_id" => operation_id(),
                   "work_id" => work.work_id,
                   "expected_revision" => 2,
                   "assignee" => "durable-next-assignee"
                 },
                 %{operator: true},
                 name
               )

      assert {:ok, %{work: before}} = WorkStore.status(operator, work.work_id, name)
      path = :sys.get_state(name).path
      GenServer.stop(name)
      {:ok, _} = WorkStore.start_link(name: name, path: path)
      assert {:ok, %{work: ^before}} = WorkStore.status(operator, work.work_id, name)
      assert length(before.holds) == 1
      assert [%{state: "pending"}] = before.transfers

      assert {:ok, %{operation_id: ^hold_operation_id}} =
               WorkStore.op_result(director, hold_operation_id, name)
    end)
  end

  test "V22 per-work receipt cap refuses new work without evicting old receipts" do
    with_store("receipt_per_work", fn name ->
      director = %{"kind" => "agent", "id" => "receipt-director"}
      assignee = %{"kind" => "agent", "id" => "receipt-assignee"}
      work = active_work(name, director["id"], assignee, "receipt-cid")
      {:ok, %{work: initial}} = WorkStore.status(assignee, work.work_id, name)
      oldest = Enum.find(Enum.reverse(initial.receipts), &(&1.principal == assignee))

      for i <- 1..63 do
        assert {:ok, _} =
                 WorkStore.apply(
                   assignee,
                   %{
                     "op" => "submit",
                     "operation_id" => operation_id(),
                     "work_id" => work.work_id,
                     "basis_revision" => 1,
                     "subject" => %{"hash" => "H#{i}", "label" => "Artifact"}
                   },
                   %{recipient: director["id"], conversation_id: "receipt-cid"},
                   name
                 )
      end

      assert {:error, :work_capacity} =
               WorkStore.apply(
                 assignee,
                 %{
                   "op" => "submit",
                   "operation_id" => operation_id(),
                   "work_id" => work.work_id,
                   "basis_revision" => 1,
                   "subject" => %{"hash" => "overflow", "label" => "Artifact"}
                 },
                 %{recipient: director["id"], conversation_id: "receipt-cid"},
                 name
               )

      assert {:ok, %{operation_id: oldest_id}} =
               WorkStore.op_result(assignee, oldest.operation_id, name)

      assert oldest_id == oldest.operation_id

      assert {:ok, %{work: %{revision: 2}}} =
               WorkStore.apply(
                 director,
                 %{
                   "op" => "revise",
                   "operation_id" => operation_id(),
                   "work_id" => work.work_id,
                   "expected_revision" => 1
                 },
                 %{recipient: assignee["id"], conversation_id: "receipt-cid"},
                 name
               )
    end)
  end

  test "V22 global receipt cap refuses new work without evicting old receipts" do
    with_store("receipt_global", fn name ->
      assignee = %{"kind" => "agent", "id" => "global-receipt-assignee"}

      works =
        for index <- 1..17 do
          director = %{"kind" => "agent", "id" => "global-receipt-director-#{index}"}
          work = active_work(name, director["id"], assignee, "global-receipt-#{index}")
          count = if index == 17, do: 63, else: 59

          for i <- 1..count do
            assert {:ok, _} =
                     WorkStore.apply(
                       assignee,
                       %{
                         "op" => "submit",
                         "operation_id" => operation_id(),
                         "work_id" => work.work_id,
                         "basis_revision" => 1,
                         "subject" => %{"hash" => "H#{index}-#{i}", "label" => "Artifact"}
                       },
                       %{recipient: director["id"], conversation_id: "global-receipt-#{index}"},
                       name
                     )
          end

          if index == 16 do
            assert {:ok, _} =
                     WorkStore.apply(
                       director,
                       %{
                         "op" => "cancel",
                         "operation_id" => operation_id(),
                         "work_id" => work.work_id,
                         "expected_revision" => 1
                       },
                       %{recipient: assignee["id"], conversation_id: "global-receipt-16"},
                       name
                     )
          end

          {work, director}
        end

      {first, first_director} = hd(works)
      {:ok, %{work: before}} = WorkStore.status(first_director, first.work_id, name)
      oldest = Enum.find(Enum.reverse(before.receipts), &(&1.principal == assignee))

      assert {:error, :work_capacity} =
               WorkStore.apply(
                 assignee,
                 %{
                   "op" => "submit",
                   "operation_id" => operation_id(),
                   "work_id" => first.work_id,
                   "basis_revision" => 1,
                   "subject" => %{"hash" => "global-overflow", "label" => "Artifact"}
                 },
                 %{recipient: first_director["id"], conversation_id: "global-receipt-1"},
                 name
               )

      assert {:ok, %{operation_id: oldest_id}} =
               WorkStore.op_result(assignee, oldest.operation_id, name)

      assert oldest_id == oldest.operation_id

      assert {:ok, %{work: %{revision: 2}}} =
               WorkStore.apply(
                 first_director,
                 %{
                   "op" => "revise",
                   "operation_id" => operation_id(),
                   "work_id" => first.work_id,
                   "expected_revision" => 1
                 },
                 %{recipient: assignee["id"], conversation_id: "global-receipt-1"},
                 name
               )
    end)
  end

  test "V28 and V29 conversation carriage and one work link" do
    with_store("carriage_links", fn name ->
      director = %{"kind" => "agent", "id" => "carriage-director"}
      assignee = %{"kind" => "agent", "id" => "carriage-assignee"}
      first = active_work(name, director["id"], assignee, "carriage-first")
      _second = active_work(name, director["id"], assignee, "carriage-second")

      assert {:error, :work_carriage_invalid} =
               WorkStore.apply(
                 director,
                 %{
                   "op" => "revise",
                   "operation_id" => operation_id(),
                   "work_id" => first.work_id,
                   "expected_revision" => 1
                 },
                 %{recipient: assignee["id"], conversation_id: "carriage-second"},
                 name
               )

      assert {:error, :work_link_conflict} =
               WorkStore.apply(
                 director,
                 %{
                   "op" => "assign",
                   "operation_id" => operation_id(),
                   "title" => "Another work"
                 },
                 %{
                   recipient: assignee["id"],
                   conversation_id: "carriage-first",
                   turn_number: 3,
                   new_conversation?: false
                 },
                 name
               )

      assert {:ok, %{work: %{revision: 1, links: ["carriage-first"]}}} =
               WorkStore.status(director, first.work_id, name)

      assert map_size(WorkStore.all(name)) == 2
    end)
  end

  test "V17 unrelated agent cannot nominate a review of another director's work" do
    with_store("review_authority", fn name ->
      assignee = %{"kind" => "agent", "id" => "review-target-assignee"}
      target = active_work(name, "review-target-director", assignee, "review-target-cid")
      outsider = %{"kind" => "agent", "id" => "review-outsider"}
      reviewer = %{"kind" => "agent", "id" => "review-candidate"}

      assert {:error, :work_not_authorized} =
               WorkStore.apply(
                 outsider,
                 %{
                   "op" => "assign",
                   "operation_id" => operation_id(),
                   "title" => "unauthorized review",
                   "reviews" => target.work_id
                 },
                 %{
                   recipient: reviewer["id"],
                   conversation_id: "unauthorized-review-cid",
                   turn_number: 1,
                   new_conversation?: true
                 },
                 name
               )

      assert map_size(WorkStore.all(name)) == 1
      assert {:error, :unknown_work} = WorkStore.status(reviewer, target.work_id, name)
    end)
  end

  test "accepting a nomination respects the active assignee capacity" do
    previous = Application.fetch_env!(:kaoiro_server, :work_store)

    Application.put_env(
      :kaoiro_server,
      :work_store,
      Keyword.put(previous, :work_active_per_assignee, 1)
    )

    on_exit(fn -> Application.put_env(:kaoiro_server, :work_store, previous) end)

    with_store("active_cap", fn name ->
      recipient = %{"kind" => "agent", "id" => "active-cap-assignee"}
      _first = active_work(name, "active-cap-first-director", recipient, "active-cap-first")
      director = %{"kind" => "agent", "id" => "active-cap-second-director"}

      assert {:ok, %{work: nomination}} =
               WorkStore.apply(
                 director,
                 %{"op" => "assign", "operation_id" => operation_id(), "title" => "second"},
                 %{
                   recipient: recipient["id"],
                   conversation_id: "active-cap-second",
                   turn_number: 1,
                   new_conversation?: true
                 },
                 name
               )

      assert {:error, :work_capacity} =
               WorkStore.apply(
                 recipient,
                 %{
                   "op" => "accept_assignment",
                   "operation_id" => operation_id(),
                   "work_id" => nomination.work_id
                 },
                 %{
                   recipient: director["id"],
                   conversation_id: "active-cap-second",
                   turn_number: 2
                 },
                 name
               )

      assert {:ok, %{work: %{state: "nominated"}}} =
               WorkStore.status(recipient, nomination.work_id, name)
    end)
  end

  test "V11 and V15: assignee basis and completion subject must be current" do
    with_store("subject", fn name ->
      assignee = %{"kind" => "agent", "id" => "subject-assignee"}
      director = %{"kind" => "agent", "id" => "subject-director"}
      work = active_work(name, director["id"], assignee, "subject-cid")

      assert {:ok, %{work: %{revision: 2}}} =
               WorkStore.apply(
                 director,
                 %{
                   "op" => "revise",
                   "operation_id" => operation_id(),
                   "work_id" => work.work_id,
                   "expected_revision" => 1
                 },
                 %{recipient: assignee["id"], conversation_id: "subject-cid"},
                 name
               )

      submit = %{
        "op" => "submit",
        "work_id" => work.work_id,
        "subject" => %{"hash" => "H1", "label" => "candidate"}
      }

      context = %{recipient: director["id"], conversation_id: "subject-cid"}

      assert {:error, :stale_work_revision} =
               WorkStore.apply(
                 assignee,
                 submit
                 |> Map.put("basis_revision", 1)
                 |> Map.put("operation_id", operation_id()),
                 context,
                 name
               )

      assert {:error, :subject_mismatch} =
               WorkStore.apply(
                 director,
                 %{
                   "op" => "complete",
                   "operation_id" => operation_id(),
                   "work_id" => work.work_id,
                   "expected_revision" => 2,
                   "subject_hash" => nil
                 },
                 %{recipient: assignee["id"], conversation_id: "subject-cid"},
                 name
               )

      assert {:error, :work_state_conflict} =
               WorkStore.apply(
                 assignee,
                 submit
                 |> Map.put("basis_revision", 2)
                 |> Map.put("subject", %{"hash" => "", "label" => "candidate"})
                 |> Map.put("operation_id", operation_id()),
                 context,
                 name
               )

      assert {:ok, _} =
               WorkStore.apply(
                 assignee,
                 submit
                 |> Map.put("basis_revision", 2)
                 |> Map.put("operation_id", operation_id()),
                 context,
                 name
               )

      assert {:ok, %{work: %{subject: %{hash: "H1"}}}} =
               WorkStore.status(director, work.work_id, name)

      assert {:error, :subject_mismatch} =
               WorkStore.apply(
                 director,
                 %{
                   "op" => "complete",
                   "operation_id" => operation_id(),
                   "work_id" => work.work_id,
                   "expected_revision" => 2,
                   "subject_hash" => "H0"
                 },
                 %{recipient: assignee["id"], conversation_id: "subject-cid"},
                 name
               )

      assert {:ok, %{work: %{state: "active", subject: %{hash: "H1"}}}} =
               WorkStore.status(director, work.work_id, name)
    end)
  end

  test "V18: transfer acknowledgements are bound to the old assignee and transfer id" do
    with_store("transfer_ack", fn name ->
      operator = %{"kind" => "user", "id" => "transfer-operator"}
      a = %{"kind" => "agent", "id" => "transfer-ack-a"}
      b = %{"kind" => "agent", "id" => "transfer-ack-b"}
      c = %{"kind" => "agent", "id" => "transfer-ack-c"}
      work = active_work(name, "transfer-ack-director", a, "transfer-ack-cid")

      assert {:ok, _} =
               WorkStore.apply(
                 operator,
                 %{
                   "op" => "transfer",
                   "operation_id" => operation_id(),
                   "work_id" => work.work_id,
                   "expected_revision" => 1,
                   "assignee" => b["id"]
                 },
                 %{operator: true},
                 name
               )

      {:ok, %{work: first}} = WorkStore.status(operator, work.work_id, name)

      assert {:ok, _} =
               WorkStore.apply(
                 operator,
                 %{
                   "op" => "transfer",
                   "operation_id" => operation_id(),
                   "work_id" => work.work_id,
                   "expected_revision" => 2,
                   "assignee" => c["id"]
                 },
                 %{operator: true},
                 name
               )

      {:ok, %{work: second}} = WorkStore.status(operator, work.work_id, name)

      [newer, older] = second.transfers
      assert older.transfer_id == hd(first.transfers).transfer_id

      assert {:error, :work_not_authorized} =
               WorkStore.transfer_ack(c, work.work_id, older.transfer_id, name)

      assert {:ok, acknowledged} =
               WorkStore.transfer_ack(a, work.work_id, older.transfer_id, name)

      assert Enum.find(acknowledged.transfers, &(&1.transfer_id == older.transfer_id)).state ==
               "acknowledged"

      assert Enum.find(acknowledged.transfers, &(&1.transfer_id == newer.transfer_id)).state ==
               "pending"

      assert %{ok: false, reason: :transfer_pending} =
               WorkStore.check(
                 c,
                 %{
                   "work_id" => work.work_id,
                   "action" => "start",
                   "expected_revision" => second.revision
                 },
                 name
               )

      assert {:ok, _} = WorkStore.transfer_ack(b, work.work_id, newer.transfer_id, name)

      assert %{ok: true} =
               WorkStore.check(
                 c,
                 %{
                   "work_id" => work.work_id,
                   "action" => "start",
                   "expected_revision" => second.revision
                 },
                 name
               )
    end)
  end

  test "V19 V20 V23 V43: receipts survive restart and are scoped to principal" do
    with_store("receipt", fn name ->
      assignee = %{"kind" => "agent", "id" => "receipt-assignee"}
      director = %{"kind" => "agent", "id" => "receipt-director"}
      cid = "receipt-cid"
      same_id = operation_id()
      assign = %{"op" => "assign", "operation_id" => same_id, "title" => "receipt work"}

      nomination_context = %{
        recipient: assignee["id"],
        conversation_id: cid,
        turn_number: 1,
        new_conversation?: true
      }

      assert {:ok, %{work: nominated}} =
               WorkStore.apply(director, assign, nomination_context, name)

      assert {:duplicate, %{result: %{work: %{work_id: id}}}} =
               WorkStore.apply(
                 director,
                 assign,
                 %{nomination_context | new_conversation?: false},
                 name
               )

      assert id == nominated.work_id

      assert {:ok, %{work: active}} =
               WorkStore.apply(
                 assignee,
                 %{"op" => "accept_assignment", "operation_id" => same_id, "work_id" => id},
                 %{recipient: director["id"], conversation_id: cid},
                 name
               )

      submit = %{
        "op" => "submit",
        "operation_id" => operation_id(),
        "work_id" => id,
        "basis_revision" => active.revision,
        "subject" => %{"hash" => "H", "label" => "artifact"}
      }

      context = %{recipient: director["id"], conversation_id: cid}

      assert {:ok, _} =
               WorkStore.apply(assignee, submit, context, name)

      assert {:ok, %{work: %{subject: %{seq: 1}}}} =
               WorkStore.status(director, id, name)

      path = :sys.get_state(name).path
      GenServer.stop(name)
      {:ok, _} = WorkStore.start_link(name: name, path: path)

      assert {:ok, %{operation_id: restarted_operation_id}} =
               WorkStore.op_result(assignee, submit["operation_id"], name)

      assert restarted_operation_id == submit["operation_id"]

      assert {:duplicate, %{result: %{work: %{work_id: ^id}}}} =
               WorkStore.apply(assignee, submit, context, name)

      assert {:ok, %{work: %{subject: %{seq: 1}}}} =
               WorkStore.status(director, id, name)
    end)
  end

  test "V23 a repeated submit does not advance the subject sequence" do
    with_store("submit_dedup", fn name ->
      assignee = %{"kind" => "agent", "id" => "dedup-assignee"}
      director = %{"kind" => "agent", "id" => "dedup-director"}
      work = active_work(name, director["id"], assignee, "dedup-cid")

      submit = %{
        "op" => "submit",
        "operation_id" => operation_id(),
        "work_id" => work.work_id,
        "basis_revision" => work.revision,
        "subject" => %{"hash" => "dedup-H", "label" => "artifact"}
      }

      context = %{recipient: director["id"], conversation_id: "dedup-cid"}
      assert {:ok, first} = WorkStore.apply(assignee, submit, context, name)
      assert {:duplicate, %{result: ^first}} = WorkStore.apply(assignee, submit, context, name)

      assert {:ok, %{work: %{subject: %{seq: 1}}}} =
               WorkStore.status(director, work.work_id, name)
    end)
  end

  test "V13 V14: only live approvals authorize landing and void never revives" do
    with_store("verdict", fn name ->
      director = %{"kind" => "agent", "id" => "verdict-director"}
      assignee = %{"kind" => "agent", "id" => "verdict-assignee"}
      reviewer = %{"kind" => "agent", "id" => "verdict-reviewer"}
      target = active_work(name, director["id"], assignee, "verdict-target-cid")

      assert {:ok, %{work: nomination}} =
               WorkStore.apply(
                 director,
                 %{
                   "op" => "assign",
                   "operation_id" => operation_id(),
                   "title" => "Review",
                   "reviews" => target.work_id
                 },
                 %{
                   recipient: reviewer["id"],
                   conversation_id: "verdict-review-cid",
                   turn_number: 1,
                   new_conversation?: true
                 },
                 name
               )

      assert {:ok, %{work: review}} =
               WorkStore.apply(
                 reviewer,
                 %{
                   "op" => "accept_assignment",
                   "operation_id" => operation_id(),
                   "work_id" => nomination.work_id
                 },
                 %{
                   recipient: director["id"],
                   conversation_id: "verdict-review-cid",
                   turn_number: 2
                 },
                 name
               )

      submit = fn hash ->
        {:ok, %{work: current}} = WorkStore.status(assignee, target.work_id, name)

        WorkStore.apply(
          assignee,
          %{
            "op" => "submit",
            "operation_id" => operation_id(),
            "work_id" => target.work_id,
            "basis_revision" => current.revision,
            "subject" => %{"hash" => hash, "label" => "artifact"}
          },
          %{recipient: director["id"], conversation_id: "verdict-target-cid"},
          name
        )
      end

      assert {:ok, _} = submit.("H1")

      verdict = fn outcome ->
        WorkStore.apply(
          reviewer,
          %{
            "op" => "verdict",
            "operation_id" => operation_id(),
            "work_id" => review.work_id,
            "basis_revision" => 1,
            "subject" => %{"work_id" => target.work_id, "hash" => "H1"},
            "outcome" => outcome
          },
          %{recipient: director["id"], conversation_id: "verdict-review-cid"},
          name
        )
      end

      assert {:ok, _} = verdict.("reject")
      {:ok, %{work: rejected_review}} = WorkStore.status(reviewer, review.work_id, name)
      reject_id = hd(rejected_review.verdicts).verdict_id

      accept = fn verdict_id, revision ->
        WorkStore.apply(
          director,
          %{
            "op" => "accept_verdict",
            "operation_id" => operation_id(),
            "work_id" => target.work_id,
            "expected_revision" => revision,
            "subject_hash" => "H1",
            "verdict_ref" => %{"work_id" => review.work_id, "verdict_id" => verdict_id}
          },
          %{recipient: assignee["id"], conversation_id: "verdict-target-cid"},
          name
        )
      end

      assert {:error, :work_state_conflict} = accept.(reject_id, 1)
      assert {:ok, _} = verdict.("approve")
      {:ok, %{work: approved_review}} = WorkStore.status(reviewer, review.work_id, name)
      approve_id = hd(approved_review.verdicts).verdict_id
      assert {:ok, _} = accept.(approve_id, 1)

      land = fn hash, revision ->
        WorkStore.check(
          assignee,
          %{
            "work_id" => target.work_id,
            "action" => "land",
            "subject_hash" => hash,
            "expected_revision" => revision
          },
          name
        )
      end

      assert %{ok: true} = land.("H1", 2)
      assert {:ok, _} = submit.("H2")
      assert {:ok, _} = submit.("H1")
      assert %{ok: false, reason: :verdict_not_effective} = land.("H1", 2)
      {:ok, %{work: updated_target}} = WorkStore.status(director, target.work_id, name)
      assert [%{void: "subject_changed"}] = updated_target.accepted_verdicts
    end)
  end

  test "V14a withdrawal of an accepted approval blocks landing" do
    with_store("withdrawal", fn name ->
      %{
        target: target,
        review: review,
        director: director,
        assignee: assignee,
        reviewer: reviewer,
        verdict_id: verdict_id
      } = accepted_review(name, "withdrawal")

      assert {:ok, _} =
               WorkStore.apply(
                 reviewer,
                 %{
                   "op" => "withdraw_verdict",
                   "operation_id" => operation_id(),
                   "work_id" => review.work_id,
                   "verdict_id" => verdict_id
                 },
                 %{recipient: director["id"], conversation_id: "withdrawal-review"},
                 name
               )

      assert %{ok: false, reason: :verdict_not_effective} =
               WorkStore.check(
                 assignee,
                 %{
                   "work_id" => target.work_id,
                   "action" => "land",
                   "expected_revision" => 2,
                   "subject_hash" => "H"
                 },
                 name
               )
    end)
  end

  test "V14b newer rejection supersedes an accepted approval" do
    with_store("supersession", fn name ->
      %{
        target: target,
        review: review,
        director: director,
        assignee: assignee,
        reviewer: reviewer
      } = accepted_review(name, "supersession")

      assert {:ok, _} =
               WorkStore.apply(
                 reviewer,
                 %{
                   "op" => "verdict",
                   "operation_id" => operation_id(),
                   "work_id" => review.work_id,
                   "basis_revision" => 1,
                   "subject" => %{"work_id" => target.work_id, "hash" => "H"},
                   "outcome" => "reject"
                 },
                 %{recipient: director["id"], conversation_id: "supersession-review"},
                 name
               )

      assert %{ok: false, reason: :verdict_not_effective} =
               WorkStore.check(
                 assignee,
                 %{
                   "work_id" => target.work_id,
                   "action" => "land",
                   "expected_revision" => 2,
                   "subject_hash" => "H"
                 },
                 name
               )
    end)
  end

  test "V14c V14d V14e V14f review authority changes invalidate accepted verdicts" do
    for change <- ~w(revise hold release cancel) do
      with_store("invalidate_#{change}", fn name ->
        %{
          target: target,
          review: review,
          director: director,
          assignee: assignee,
          reviewer: reviewer,
          hold_id: held_id
        } = accepted_review(name, "invalidate-#{change}", change == "release")

        {revision, hold_id} =
          if change == "release", do: {2, held_id}, else: {1, nil}

        if change == "release" do
          assert %{ok: true} =
                   WorkStore.check(
                     assignee,
                     %{
                       "work_id" => target.work_id,
                       "action" => "land",
                       "expected_revision" => 2,
                       "subject_hash" => "H"
                     },
                     name
                   )
        end

        operation = %{
          "op" => change,
          "operation_id" => operation_id(),
          "work_id" => review.work_id,
          "expected_revision" => revision
        }

        operation =
          case change do
            "hold" -> Map.put(operation, "reason", "review hold")
            "release" -> operation |> Map.put("hold_id", hold_id) |> Map.put("subject_hash", nil)
            _ -> operation
          end

        assert {:ok, _} =
                 WorkStore.apply(
                   director,
                   operation,
                   %{recipient: reviewer["id"], conversation_id: "invalidate-#{change}-review"},
                   name
                 )

        {:ok, %{work: changed_review}} = WorkStore.status(director, review.work_id, name)
        assert [%{state: "invalidated"}] = changed_review.verdicts

        assert %{ok: false, reason: :verdict_not_effective} =
                 WorkStore.check(
                   assignee,
                   %{
                     "work_id" => target.work_id,
                     "action" => "land",
                     "expected_revision" => 2,
                     "subject_hash" => "H"
                   },
                   name
                 )
      end)
    end
  end

  test "V14g completing a review keeps its accepted approval effective" do
    with_store("review_complete", fn name ->
      %{
        target: target,
        review: review,
        director: director,
        assignee: assignee,
        reviewer: reviewer
      } = accepted_review(name, "review-complete")

      assert {:ok, _} =
               WorkStore.apply(
                 reviewer,
                 %{
                   "op" => "submit",
                   "operation_id" => operation_id(),
                   "work_id" => review.work_id,
                   "basis_revision" => 1,
                   "subject" => %{"hash" => "review-H", "label" => "Review"}
                 },
                 %{recipient: director["id"], conversation_id: "review-complete-review"},
                 name
               )

      assert {:ok, _} =
               WorkStore.apply(
                 director,
                 %{
                   "op" => "complete",
                   "operation_id" => operation_id(),
                   "work_id" => review.work_id,
                   "expected_revision" => 1,
                   "subject_hash" => "review-H"
                 },
                 %{recipient: reviewer["id"], conversation_id: "review-complete-review"},
                 name
               )

      {:ok, %{work: completed}} = WorkStore.status(director, review.work_id, name)
      assert [%{state: "recorded"}] = completed.verdicts

      assert %{ok: true} =
               WorkStore.check(
                 assignee,
                 %{
                   "work_id" => target.work_id,
                   "action" => "land",
                   "expected_revision" => 2,
                   "subject_hash" => "H"
                 },
                 name
               )
    end)
  end

  test "V14i previous reviewer cannot withdraw after transfer" do
    with_store("former_reviewer", fn name ->
      %{review: review, reviewer: reviewer, verdict_id: verdict_id} =
        accepted_review(name, "former-reviewer")

      operator = %{"kind" => "user", "id" => "review-operator"}

      assert {:ok, _} =
               WorkStore.apply(
                 operator,
                 %{
                   "op" => "transfer",
                   "operation_id" => operation_id(),
                   "work_id" => review.work_id,
                   "expected_revision" => 1,
                   "assignee" => "replacement-reviewer"
                 },
                 %{operator: true},
                 name
               )

      assert {:error, :work_not_authorized} =
               WorkStore.apply(
                 reviewer,
                 %{
                   "op" => "withdraw_verdict",
                   "operation_id" => operation_id(),
                   "work_id" => review.work_id,
                   "verdict_id" => verdict_id
                 },
                 %{
                   recipient: "former-reviewer-director",
                   conversation_id: "former-reviewer-review"
                 },
                 name
               )

      assert {:ok, %{work: %{verdicts: [%{state: "recorded"}]}}} =
               WorkStore.status(operator, review.work_id, name)
    end)
  end

  test "V16 completion and landing each enforce hold revision subject and verdict" do
    with_store("landing_guards", fn name ->
      director = %{"kind" => "agent", "id" => "landing-director"}
      assignee = %{"kind" => "agent", "id" => "landing-assignee"}
      work = active_work(name, director["id"], assignee, "landing-cid")

      assert {:ok, _} =
               WorkStore.apply(
                 assignee,
                 %{
                   "op" => "submit",
                   "operation_id" => operation_id(),
                   "work_id" => work.work_id,
                   "basis_revision" => 1,
                   "subject" => %{"hash" => "landing-H", "label" => "Landing artifact"}
                 },
                 %{recipient: director["id"], conversation_id: "landing-cid"},
                 name
               )

      check = fn revision, hash ->
        WorkStore.check(
          assignee,
          %{
            "work_id" => work.work_id,
            "action" => "land",
            "expected_revision" => revision,
            "subject_hash" => hash
          },
          name
        )
      end

      assert %{ok: false, reason: :stale_work_revision} = check.(0, "landing-H")
      assert %{ok: false, reason: :subject_mismatch} = check.(1, "other-H")
      assert %{ok: false, reason: :verdict_not_effective} = check.(1, "landing-H")

      assert {:ok, %{work: %{revision: 2}}} =
               WorkStore.apply(
                 director,
                 %{
                   "op" => "hold",
                   "operation_id" => operation_id(),
                   "work_id" => work.work_id,
                   "expected_revision" => 1,
                   "reason" => "landing hold"
                 },
                 %{recipient: assignee["id"], conversation_id: "landing-cid"},
                 name
               )

      assert %{ok: false, reason: :work_state_conflict} = check.(2, "landing-H")

      assert {:error, :work_state_conflict} =
               WorkStore.apply(
                 director,
                 %{
                   "op" => "complete",
                   "operation_id" => operation_id(),
                   "work_id" => work.work_id,
                   "expected_revision" => 2,
                   "subject_hash" => "landing-H"
                 },
                 %{recipient: assignee["id"], conversation_id: "landing-cid"},
                 name
               )

      assert {:ok, %{work: %{state: "active", holds: [_]}}} =
               WorkStore.status(director, work.work_id, name)
    end)
  end

  test "V40: concurrent operator assignment creates one work" do
    with_store("operator_race", fn name ->
      operator = %{"kind" => "user", "id" => "operator-race"}

      assign = %{
        "op" => "assign",
        "operation_id" => operation_id(),
        "title" => "one grant",
        "assignee" => "race-assignee",
        "director" => operator,
        "requires_verdict" => false
      }

      digest = WorkStore.digest(assign)

      assert {:error, :unknown_operation} =
               WorkStore.lookup(operator, assign["operation_id"], digest, name)

      assert {:error, :unknown_operation} =
               WorkStore.lookup(operator, assign["operation_id"], digest, name)

      results =
        for _ <- 1..2,
            do:
              Task.async(fn ->
                WorkStore.apply(operator, assign, %{operator: true}, name)
              end)

      outcomes = Enum.map(results, &Task.await/1)
      assert Enum.count(outcomes, &match?({:ok, _}, &1)) == 1
      assert Enum.count(outcomes, &match?({:duplicate, _}, &1)) == 1
      assert map_size(WorkStore.all(name)) == 1
    end)
  end

  test "V41: concurrent operator revision returns the first receipt" do
    with_store("operator_revision_race", fn name ->
      operator = %{"kind" => "user", "id" => "operator-revision-race"}

      assert {:ok, %{work: grant}} =
               WorkStore.apply(
                 operator,
                 %{
                   "op" => "assign",
                   "operation_id" => operation_id(),
                   "title" => "grant",
                   "assignee" => "revision-race-assignee",
                   "director" => operator,
                   "requires_verdict" => false
                 },
                 %{operator: true},
                 name
               )

      revise = %{
        "op" => "revise",
        "operation_id" => operation_id(),
        "work_id" => grant.work_id,
        "expected_revision" => grant.revision
      }

      digest = WorkStore.digest(revise)

      assert {:error, :unknown_operation} =
               WorkStore.lookup(operator, revise["operation_id"], digest, name)

      assert {:error, :unknown_operation} =
               WorkStore.lookup(operator, revise["operation_id"], digest, name)

      tasks =
        for _ <- 1..2,
            do:
              Task.async(fn ->
                WorkStore.apply(operator, revise, %{operator: true}, name)
              end)

      outcomes = Enum.map(tasks, &Task.await/1)
      assert Enum.count(outcomes, &match?({:ok, _}, &1)) == 1
      assert Enum.count(outcomes, &match?({:duplicate, _}, &1)) == 1

      assert {:ok, %{work: %{revision: 2}}} =
               WorkStore.status(operator, grant.work_id, name)
    end)
  end

  @tag :r1_fix
  test "M1 a future operation ID keeps its receipt through sweep, restart, and terminal retention" do
    previous = Application.fetch_env!(:kaoiro_server, :work_store)

    Application.put_env(
      :kaoiro_server,
      :work_store,
      previous
      |> Keyword.put(:operation_validity_ms, 100)
      |> Keyword.put(:work_terminal_retention_ms, 0)
    )

    try do
      with_store("future_receipt", fn name ->
        operator = %{"kind" => "user", "id" => "future-receipt-operator"}

        ahead_id = fn ->
          "op_#{System.system_time(:millisecond) + 10_000}_#{Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)}"
        end

        assign = %{
          "op" => "assign",
          "operation_id" => ahead_id.(),
          "title" => "Future receipt",
          "assignee" => "future-receipt-assignee",
          "director" => operator
        }

        assert {:ok, %{work: grant}} = WorkStore.apply(operator, assign, %{operator: true}, name)
        Process.sleep(150)

        assert {:duplicate, %{result: %{work: %{work_id: first_id}}}} =
                 WorkStore.apply(operator, assign, %{operator: true}, name)

        assert first_id == grant.work_id
        assert :ok = WorkStore.sweep(name)
        assert {:duplicate, _} = WorkStore.apply(operator, assign, %{operator: true}, name)

        cancel = %{
          "op" => "cancel",
          "operation_id" => ahead_id.(),
          "work_id" => grant.work_id,
          "expected_revision" => 1
        }

        assert {:ok, _} = WorkStore.apply(operator, cancel, %{operator: true}, name)
        assert :ok = WorkStore.sweep(name)
        assert {:duplicate, _} = WorkStore.apply(operator, cancel, %{operator: true}, name)

        path = :sys.get_state(name).path
        :ok = GenServer.stop(name)
        {:ok, _} = WorkStore.start_link(name: name, path: path)
        assert {:duplicate, _} = WorkStore.apply(operator, assign, %{operator: true}, name)
        assert {:duplicate, _} = WorkStore.apply(operator, cancel, %{operator: true}, name)

        assert {:ok, %{work: %{work_id: ^first_id, state: "cancelled"}}} =
                 WorkStore.status(operator, first_id, name)
      end)
    after
      Application.put_env(:kaoiro_server, :work_store, previous)
    end
  end

  @tag :r1_fix
  test "M6 JSON verdict reference revokes an accepted approval" do
    with_store("json_revoke", fn name ->
      context = accepted_review(name, "json_revoke")
      {:ok, %{work: work}} = WorkStore.status(context.director, context.target.work_id, name)

      ref =
        work.accepted_verdicts
        |> hd()
        |> Map.fetch!(:verdict_ref)
        |> Jason.encode!()
        |> Jason.decode!()

      request =
        %{
          "op" => "revoke_verdict",
          "operation_id" => operation_id(),
          "work_id" => work.work_id,
          "expected_revision" => work.revision,
          "verdict_ref" => ref
        }
        |> Jason.encode!()
        |> Jason.decode!()

      assert {:ok, %{work: %{revision: 3}}} =
               WorkStore.apply(
                 context.director,
                 request,
                 %{recipient: context.assignee["id"], conversation_id: "json_revoke-target"},
                 name
               )

      assert {:ok, %{work: %{accepted_verdicts: []}}} =
               WorkStore.status(context.director, work.work_id, name)

      assert %{ok: false, reason: :verdict_not_effective} =
               WorkStore.check(
                 context.assignee,
                 %{
                   "work_id" => work.work_id,
                   "action" => "land",
                   "expected_revision" => 3,
                   "subject_hash" => "H"
                 },
                 name
               )
    end)
  end

  @tag :r1_fix
  test "M8 a thirty-third conversation link is refused without a revision or receipt" do
    with_store("link_bound", fn name ->
      director = %{"kind" => "agent", "id" => "link-bound-director"}
      assignee = %{"kind" => "agent", "id" => "link-bound-assignee"}
      work = active_work(name, director["id"], assignee, "link-bound-origin")

      for revision <- 1..31 do
        assert {:ok, _} =
                 WorkStore.apply(
                   director,
                   %{
                     "op" => "revise",
                     "operation_id" => operation_id(),
                     "work_id" => work.work_id,
                     "expected_revision" => revision
                   },
                   %{
                     recipient: assignee["id"],
                     conversation_id: "link-bound-#{revision}",
                     new_conversation?: true
                   },
                   name
                 )
      end

      assert {:ok, %{work: %{revision: 32, links: links}}} =
               WorkStore.status(director, work.work_id, name)

      assert length(links) == 32
      overflow_id = operation_id()

      assert {:error, :work_capacity} =
               WorkStore.apply(
                 director,
                 %{
                   "op" => "revise",
                   "operation_id" => overflow_id,
                   "work_id" => work.work_id,
                   "expected_revision" => 32
                 },
                 %{
                   recipient: assignee["id"],
                   conversation_id: "link-bound-overflow",
                   new_conversation?: true
                 },
                 name
               )

      assert {:error, :unknown_operation} = WorkStore.op_result(director, overflow_id, name)

      assert {:ok, %{work: %{revision: 32, links: ^links}}} =
               WorkStore.status(director, work.work_id, name)

      assert {:ok, %{work: %{revision: 33}}} =
               WorkStore.apply(
                 director,
                 %{
                   "op" => "revise",
                   "operation_id" => operation_id(),
                   "work_id" => work.work_id,
                   "expected_revision" => 32
                 },
                 %{recipient: assignee["id"], conversation_id: "link-bound-origin"},
                 name
               )
    end)
  end

  defp with_store(suffix, fun) do
    name = :"work_store_#{suffix}_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
    File.rm(path)
    {:ok, _} = WorkStore.start_link(name: name, path: path)

    try do
      fun.(name)
    after
      if Process.whereis(name), do: GenServer.stop(name)
      File.rm(path)
    end
  end

  defp accepted_review(name, suffix, hold_before_verdict? \\ false) do
    director = %{"kind" => "agent", "id" => "#{suffix}-director"}
    assignee = %{"kind" => "agent", "id" => "#{suffix}-assignee"}
    reviewer = %{"kind" => "agent", "id" => "#{suffix}-reviewer"}
    target = active_work(name, director["id"], assignee, "#{suffix}-target")

    assert {:ok, %{work: nomination}} =
             WorkStore.apply(
               director,
               %{
                 "op" => "assign",
                 "operation_id" => operation_id(),
                 "title" => "Review",
                 "reviews" => target.work_id,
                 "requires_verdict" => false
               },
               %{
                 recipient: reviewer["id"],
                 conversation_id: "#{suffix}-review",
                 turn_number: 1,
                 new_conversation?: true
               },
               name
             )

    assert {:ok, %{work: review}} =
             WorkStore.apply(
               reviewer,
               %{
                 "op" => "accept_assignment",
                 "operation_id" => operation_id(),
                 "work_id" => nomination.work_id
               },
               %{recipient: director["id"], conversation_id: "#{suffix}-review", turn_number: 2},
               name
             )

    hold_id =
      if hold_before_verdict? do
        assert {:ok, _} =
                 WorkStore.apply(
                   director,
                   %{
                     "op" => "hold",
                     "operation_id" => operation_id(),
                     "work_id" => review.work_id,
                     "expected_revision" => 1,
                     "reason" => "review hold"
                   },
                   %{recipient: reviewer["id"], conversation_id: "#{suffix}-review"},
                   name
                 )

        {:ok, %{work: held}} = WorkStore.status(director, review.work_id, name)
        hd(held.holds).hold_id
      end

    assert {:ok, _} =
             WorkStore.apply(
               assignee,
               %{
                 "op" => "submit",
                 "operation_id" => operation_id(),
                 "work_id" => target.work_id,
                 "basis_revision" => 1,
                 "subject" => %{"hash" => "H", "label" => "Artifact"}
               },
               %{recipient: director["id"], conversation_id: "#{suffix}-target"},
               name
             )

    assert {:ok, _} =
             WorkStore.apply(
               reviewer,
               %{
                 "op" => "verdict",
                 "operation_id" => operation_id(),
                 "work_id" => review.work_id,
                 "basis_revision" => if(hold_before_verdict?, do: 2, else: 1),
                 "subject" => %{"work_id" => target.work_id, "hash" => "H"},
                 "outcome" => "approve"
               },
               %{recipient: director["id"], conversation_id: "#{suffix}-review"},
               name
             )

    {:ok, %{work: reviewed}} = WorkStore.status(director, review.work_id, name)
    verdict_id = hd(reviewed.verdicts).verdict_id

    assert {:ok, _} =
             WorkStore.apply(
               director,
               %{
                 "op" => "accept_verdict",
                 "operation_id" => operation_id(),
                 "work_id" => target.work_id,
                 "expected_revision" => 1,
                 "subject_hash" => "H",
                 "verdict_ref" => %{"work_id" => review.work_id, "verdict_id" => verdict_id}
               },
               %{recipient: assignee["id"], conversation_id: "#{suffix}-target"},
               name
             )

    %{
      target: target,
      review: review,
      director: director,
      assignee: assignee,
      reviewer: reviewer,
      verdict_id: verdict_id,
      hold_id: hold_id
    }
  end

  defp active_work(name, director_id, recipient, cid) do
    director = %{"kind" => "agent", "id" => director_id}

    assert {:ok, %{work: nominated}} =
             WorkStore.apply(
               director,
               %{"op" => "assign", "operation_id" => operation_id(), "title" => cid},
               %{
                 recipient: recipient["id"],
                 conversation_id: cid,
                 turn_number: 1,
                 new_conversation?: true
               },
               name
             )

    assert {:ok, %{work: active}} =
             WorkStore.apply(
               recipient,
               %{
                 "op" => "accept_assignment",
                 "operation_id" => operation_id(),
                 "work_id" => nominated.work_id
               },
               %{
                 recipient: director_id,
                 conversation_id: cid,
                 turn_number: 2,
                 new_conversation?: false
               },
               name
             )

    active
  end

  defp claim_request(token, cid, work) do
    %{
      "incarnation" => "claim-incarnation",
      "generation" => "claim-generation",
      "yield_token" => token.yield_token,
      "conversation_id" => cid,
      "turn_number" => 3,
      "work_id" => work.work_id,
      "authority_epoch" => work.authority_epoch
    }
  end

  defp operation_id do
    "op_#{System.system_time(:millisecond)}_#{Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)}"
  end
end
