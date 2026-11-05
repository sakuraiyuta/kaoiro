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

  test "V5 claim refuses a token from an earlier authority epoch" do
    with_store("claim_epoch", fn name ->
      recipient = %{"kind" => "agent", "id" => "claim-epoch-recipient"}
      work = active_work(name, "claim-epoch-director", recipient, "claim-epoch-cid")
      director = %{"kind" => "agent", "id" => "claim-epoch-director"}

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

      :sys.replace_state(name, fn state ->
        put_in(state, [:works, work.work_id, :authority_epoch], 2)
      end)

      assert {:ok, %{granted: false, reason: :grant_changed}} =
               WorkStore.claim(recipient, claim_request(token, "claim-epoch-cid", work), name)

      assert :sys.get_state(name).yield_tokens[token.yield_token].state == "unclaimed"
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

      assert {:error, {:work_capacity, _}} =
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

  test "retained per-work receipts still bound basic operations" do
    previous = Application.fetch_env!(:kaoiro_server, :work_store)

    Application.put_env(
      :kaoiro_server,
      :work_store,
      Keyword.put(previous, :work_receipts_per_work_principal, 1)
    )

    on_exit(fn -> Application.put_env(:kaoiro_server, :work_store, previous) end)

    with_store("receipt_per_work", fn name ->
      director = %{"kind" => "agent", "id" => "receipt-director"}

      work =
        active_work(
          name,
          director["id"],
          %{"kind" => "agent", "id" => "receipt-assignee"},
          "receipt-cid"
        )

      assert {:error, {:work_capacity, %{limit: "work_receipts_per_work_principal"}}} =
               WorkStore.apply(
                 director,
                 %{
                   "op" => "complete",
                   "operation_id" => operation_id(),
                   "work_id" => work.work_id
                 },
                 %{recipient: "receipt-assignee", conversation_id: "receipt-cid"},
                 name
               )

      assert length(WorkStore.all(name)[work.work_id].receipts) == 2
    end)
  end

  test "global receipt capacity preserves old receipts" do
    previous = Application.fetch_env!(:kaoiro_server, :work_store)

    Application.put_env(
      :kaoiro_server,
      :work_store,
      Keyword.put(previous, :work_receipts_per_principal, 2)
    )

    on_exit(fn -> Application.put_env(:kaoiro_server, :work_store, previous) end)

    with_store("receipt_global", fn name ->
      operator = %{"kind" => "user", "id" => "receipt-operator"}

      operations =
        for n <- 1..3,
            do: %{
              "op" => "assign",
              "operation_id" => operation_id(),
              "title" => "grant",
              "assignee" => "receipt-assignee-#{n}",
              "director" => operator
            }

      for op <- Enum.take(operations, 2),
          do: assert({:ok, _} = WorkStore.apply(operator, op, %{operator: true}, name))

      assert {:error, {:work_capacity, %{limit: "work_receipts_per_principal"}}} =
               WorkStore.apply(operator, List.last(operations), %{operator: true}, name)

      assert {:duplicate, _} = WorkStore.apply(operator, hd(operations), %{operator: true}, name)
      assert map_size(WorkStore.all(name)) == 2
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
                   "op" => "cancel",
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

      assert {:error, {:work_capacity, _}} =
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

      complete = %{
        "op" => "complete",
        "operation_id" => operation_id(),
        "work_id" => id,
        "basis_revision" => active.revision,
        "subject" => %{"hash" => "H", "label" => "artifact"}
      }

      context = %{recipient: assignee["id"], conversation_id: cid}

      assert {:ok, _} =
               WorkStore.apply(director, complete, context, name)

      assert {:ok, %{work: %{state: "completed"}}} =
               WorkStore.status(director, id, name)

      path = :sys.get_state(name).path
      GenServer.stop(name)
      {:ok, _} = WorkStore.start_link(name: name, path: path)

      assert {:ok, %{operation_id: restarted_operation_id}} =
               WorkStore.op_result(director, complete["operation_id"], name)

      assert restarted_operation_id == complete["operation_id"]

      assert {:duplicate, %{result: %{work: %{work_id: ^id}}}} =
               WorkStore.apply(director, complete, context, name)

      assert {:ok, %{work: %{state: "completed"}}} =
               WorkStore.status(director, id, name)
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

  test "V41: concurrent operator cancellation returns the first receipt" do
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
        "op" => "cancel",
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

  describe "authorize_peer_reset/5 (issue #677)" do
    setup do
      name = :"work_store_peer_reset_#{System.unique_integer([:positive])}"
      path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
      File.rm(path)
      {:ok, _} = WorkStore.start_link(name: name, path: path)

      on_exit(fn ->
        stop_quietly(name)
        File.rm(path)
      end)

      %{name: name}
    end

    @operator %{"kind" => "user", "id" => "1"}

    defp operator_work(name, director, assignee_id) do
      assert {:ok, %{work: work}} =
               WorkStore.apply(
                 @operator,
                 %{
                   "op" => "assign",
                   "operation_id" => operation_id(),
                   "title" => "issue 677",
                   "assignee" => assignee_id,
                   "director" => director,
                   "requires_verdict" => false
                 },
                 %{operator: true},
                 name
               )

      work
    end

    defp principal(id), do: %{"kind" => "agent", "id" => id}

    test "director of an active grant may reset its assignee", %{name: name} do
      work = active_work(name, "pr-director", principal("pr-assignee"), "pr-cid")

      assert {:ok, work.work_id, work.authority_epoch} ==
               WorkStore.authorize_peer_reset(
                 principal("pr-director"),
                 "pr-assignee",
                 work.work_id,
                 work.authority_epoch,
                 name
               )
    end

    test "every other combination is refused with the single word", %{name: name} do
      work = active_work(name, "pr-director", principal("pr-assignee"), "pr-cid")
      other = active_work(name, "pr-other-director", principal("pr-assignee"), "pr-other-cid")
      self_directed = operator_work(name, principal("pr-self"), "pr-self")
      operator_directed = operator_work(name, @operator, "pr-op-assignee")

      nominated_director = principal("pr-nominated-director")

      assert {:ok, %{work: nominated}} =
               WorkStore.apply(
                 nominated_director,
                 %{"op" => "assign", "operation_id" => operation_id(), "title" => "nominated"},
                 %{
                   recipient: "pr-nominated-assignee",
                   conversation_id: "pr-nominated-cid",
                   turn_number: 1,
                   new_conversation?: true
                 },
                 name
               )

      refused = {:error, :reset_not_authorized}
      director = principal("pr-director")

      # unrelated requester
      assert refused ==
               WorkStore.authorize_peer_reset(
                 principal("pr-stranger"),
                 "pr-assignee",
                 work.work_id,
                 work.authority_epoch,
                 name
               )

      # same work, same director, same epoch, target is not the assignee
      assert refused ==
               WorkStore.authorize_peer_reset(
                 director,
                 "pr-bystander",
                 work.work_id,
                 work.authority_epoch,
                 name
               )

      # another work's director naming this work
      assert refused ==
               WorkStore.authorize_peer_reset(
                 principal("pr-other-director"),
                 "pr-assignee",
                 work.work_id,
                 work.authority_epoch,
                 name
               )

      assert {:ok, _, _} =
               WorkStore.authorize_peer_reset(
                 principal("pr-other-director"),
                 "pr-assignee",
                 other.work_id,
                 other.authority_epoch,
                 name
               )

      # epoch drift in either direction
      assert refused ==
               WorkStore.authorize_peer_reset(
                 director,
                 "pr-assignee",
                 work.work_id,
                 work.authority_epoch + 1,
                 name
               )

      assert refused ==
               WorkStore.authorize_peer_reset(
                 director,
                 "pr-assignee",
                 work.work_id,
                 work.authority_epoch - 1,
                 name
               )

      # director and assignee are the same agent: the self path owns that
      assert refused ==
               WorkStore.authorize_peer_reset(
                 principal("pr-self"),
                 "pr-self",
                 self_directed.work_id,
                 self_directed.authority_epoch,
                 name
               )

      # operator-directed work: the principal kinds differ even with equal ids
      assert refused ==
               WorkStore.authorize_peer_reset(
                 principal("1"),
                 "pr-op-assignee",
                 operator_directed.work_id,
                 operator_directed.authority_epoch,
                 name
               )

      # unknown work and the atom-key shape a caller must never pass
      assert refused ==
               WorkStore.authorize_peer_reset(director, "pr-assignee", "wrk_missing", 1, name)

      assert refused ==
               WorkStore.authorize_peer_reset(
                 %{kind: "agent", id: "pr-director"},
                 "pr-assignee",
                 work.work_id,
                 work.authority_epoch,
                 name
               )

      # not yet accepted
      assert refused ==
               WorkStore.authorize_peer_reset(
                 nominated_director,
                 "pr-nominated-assignee",
                 nominated.work_id,
                 nominated.authority_epoch,
                 name
               )
    end

    test "only an active grant authorizes; each terminal state refuses", %{name: name} do
      work = active_work(name, "pr-director", principal("pr-assignee"), "pr-cid")
      director = principal("pr-director")

      for state <- ~w(completed cancelled declined expired) do
        # The reducer's transitions into each terminal state are covered by
        # its own suite; this pins the `state == "active"` condition itself.
        :sys.replace_state(name, fn store ->
          put_in(store, [:works, work.work_id, :state], state)
        end)

        assert {:error, :reset_not_authorized} ==
                 WorkStore.authorize_peer_reset(
                   director,
                   "pr-assignee",
                   work.work_id,
                   work.authority_epoch,
                   name
                 ),
               state
      end

      :sys.replace_state(name, fn store ->
        put_in(store, [:works, work.work_id, :state], "active")
      end)

      assert {:ok, _, _} =
               WorkStore.authorize_peer_reset(
                 director,
                 "pr-assignee",
                 work.work_id,
                 work.authority_epoch,
                 name
               )
    end
  end

  describe "titles_for_ids/3 (issue #682)" do
    setup do
      name = :"work_store_titles_#{System.unique_integer([:positive])}"
      path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
      File.rm(path)
      {:ok, _} = WorkStore.start_link(name: name, path: path)

      on_exit(fn ->
        stop_quietly(name)
        File.rm(path)
      end)

      %{name: name}
    end

    test "resolves active work titles, ignores unknown or empty ids, and does not mutate store state",
         %{name: name} do
      work = active_work(name, "host-a.director", principal("host-a.assignee"), "titles-cid-1")
      before_state = :sys.get_state(name)

      assert %{} == WorkStore.titles_for_ids([], name)
      assert %{} == WorkStore.titles_for_ids(["", "wrk_unknown"], name)

      assert %{work.work_id => "titles-cid-1"} ==
               WorkStore.titles_for_ids([work.work_id, "wrk_unknown", work.work_id], name)

      assert :sys.get_state(name) == before_state
    end

    test "omits a terminal work past work_terminal_retention_ms unless it still holds a live receipt",
         %{name: name} do
      work = active_work(name, "host-a.director", principal("host-a.assignee"), "titles-cid-2")
      cfg = Application.get_env(:kaoiro_server, :work_store, [])
      retention_ms = Keyword.get(cfg, :work_terminal_retention_ms, 86_400_000)
      validity_ms = Keyword.get(cfg, :operation_validity_ms, 600_000)

      expired_updated_at =
        DateTime.utc_now()
        |> DateTime.add(-(retention_ms + 5_000), :millisecond)
        |> DateTime.to_iso8601()

      stale_issued_at = System.system_time(:millisecond) - validity_ms - 5_000

      # Terminal work within retention window: still returned
      :sys.replace_state(name, fn store ->
        put_in(store, [:works, work.work_id, :state], "completed")
      end)

      assert %{work.work_id => "titles-cid-2"} == WorkStore.titles_for_ids([work.work_id], name)

      # Terminal work past retention window, but with a live receipt: still returned
      :sys.replace_state(name, fn store ->
        update_in(store, [:works, work.work_id], fn w ->
          %{w | state: "completed", updated_at: expired_updated_at}
        end)
      end)

      assert %{work.work_id => "titles-cid-2"} == WorkStore.titles_for_ids([work.work_id], name)

      # Terminal work past retention window with only expired receipts: omitted
      :sys.replace_state(name, fn store ->
        update_in(store, [:works, work.work_id], fn w ->
          stale_receipts =
            Enum.map(w.receipts, fn r ->
              %{r | operation_id: "op_#{stale_issued_at}_stale", issued_at_ms: stale_issued_at}
            end)

          %{w | state: "completed", updated_at: expired_updated_at, receipts: stale_receipts}
        end)
      end)

      assert %{} == WorkStore.titles_for_ids([work.work_id], name)
    end

    test "returns %{} without raising when the store is not running or times out", %{name: name} do
      dead_name = :"work_store_dead_titles_#{System.unique_integer([:positive])}"

      ExUnit.CaptureLog.capture_log(fn ->
        assert %{} == WorkStore.titles_for_ids(["wrk_1"], dead_name)
      end)

      pid = Process.whereis(name)
      :sys.suspend(pid)
      on_exit(fn -> if Process.alive?(pid), do: :sys.resume(pid) end)

      ExUnit.CaptureLog.capture_log(fn ->
        assert %{} == WorkStore.titles_for_ids(["wrk_1"], name, 30)
      end)

      :sys.resume(pid)
    end
  end

  defp operation_id do
    "op_#{System.system_time(:millisecond)}_#{Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)}"
  end
end
