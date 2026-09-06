defmodule KaoiroServer.PermissionSettingsTest do
  use ExUnit.Case, async: true

  import KaoiroServer.TestTeardown

  alias KaoiroServer.PermissionSettings
  alias KaoiroServer.PermissionSettings.State

  # Mirrors SessionPointers' isolation setup: a cross-BEAM-unique path so
  # concurrent `mix test` invocations never race the same DETS file
  # (issue #187), plus a fresh table name per test.
  setup do
    name = :"ps_#{System.unique_integer([:positive])}"

    beam_nonce =
      "#{System.pid()}_" <> Base.url_encode64(:crypto.strong_rand_bytes(4), padding: false)

    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}_#{beam_nonce}.dets"])
    File.rm(path)
    {:ok, pid} = PermissionSettings.start_link(name: name, path: path)

    on_exit(fn ->
      stop_quietly(pid)
      File.rm(path)
    end)

    %{server: name, path: path}
  end

  defp wait_until(predicate, attempts \\ 50) do
    cond do
      predicate.() -> :ok
      attempts <= 0 -> :timeout
      true -> Process.sleep(5) && wait_until(predicate, attempts - 1)
    end
  end

  defp baseline_control(overrides) do
    Map.merge(
      %{
        "revision" => 0,
        "requested" => %{"sandbox" => "read-only", "network_access" => false},
        "status" => "pending",
        "constraints" => %{"approval" => "never", "enforcement" => "os"}
      },
      overrides
    )
  end

  defp seed_baseline(server, agent_id, overrides \\ %{}) do
    :ok =
      PermissionSettings.record_observation(
        agent_id,
        "codex",
        baseline_control(overrides),
        server
      )

    :ok = wait_until(fn -> PermissionSettings.get(agent_id, server) != nil end)
  end

  # ---- submit_request ---------------------------------------------------

  describe "submit_request/6" do
    test "no baseline yet returns permission_not_ready", %{server: server} do
      assert State.submit(
               nil,
               0,
               "codex",
               %{sandbox: "workspace-write"},
               %{kind: "user", id: "u1"},
               "2026-09-06T00:00:00Z"
             ) == {:error, :permission_not_ready}

      assert PermissionSettings.submit_request(
               "a.none",
               "codex",
               %{sandbox: "workspace-write"},
               %{kind: "user", id: "u1"},
               "2026-09-06T00:00:00Z",
               server
             ) == {:error, :permission_not_ready}
    end

    test "first accepted request becomes revision 1 and merges onto the baseline pair", %{
      server: server
    } do
      seed_baseline(server, "a.1")

      assert {:ok, 1, %{sandbox: "workspace-write", network_access: false}} =
               PermissionSettings.submit_request(
                 "a.1",
                 "codex",
                 %{sandbox: "workspace-write"},
                 %{kind: "user", id: "u1"},
                 "2026-09-06T00:00:01Z",
                 server
               )

      entry = PermissionSettings.get("a.1", server)
      assert entry.control.revision == 1
      assert entry.control.status == :pending
      assert entry.control.actor == %{kind: "user", id: "u1"}

      assert entry.next == %{
               revision: 1,
               requested: %{sandbox: "workspace-write", network_access: false}
             }
    end

    test "a network_access-only patch keeps the existing sandbox axis", %{server: server} do
      seed_baseline(server, "a.2", %{
        "requested" => %{"sandbox" => "workspace-write", "network_access" => false}
      })

      assert {:ok, 1, %{sandbox: "workspace-write", network_access: true}} =
               PermissionSettings.submit_request(
                 "a.2",
                 "codex",
                 %{network_access: true},
                 %{kind: "user", id: "u1"},
                 "t",
                 server
               )
    end

    test "revision is monotonic across successive accepted requests", %{server: server} do
      seed_baseline(server, "a.3")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "a.3",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t1",
          server
        )

      assert {:ok, 2, %{sandbox: "danger-full-access"}} =
               PermissionSettings.submit_request(
                 "a.3",
                 "codex",
                 %{sandbox: "danger-full-access"},
                 %{kind: "user", id: "u1"},
                 "t2",
                 server
               )
    end

    test "constraints carry forward unchanged from the baseline onto a new request", %{
      server: server
    } do
      seed_baseline(server, "a.4")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "a.4",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      entry = PermissionSettings.get("a.4", server)
      assert entry.control.constraints == %{approval: "never", enforcement: "os"}
    end

    test "revision survives a restart from the same DETS file", %{
      server: server,
      path: path
    } do
      seed_baseline(server, "a.5")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "a.5",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      :ok = GenServer.stop(server)

      name2 = :"ps_restart_#{System.unique_integer([:positive])}"
      {:ok, pid2} = PermissionSettings.start_link(name: name2, path: path)

      assert {:ok, 2, _} =
               PermissionSettings.submit_request(
                 "a.5",
                 "codex",
                 %{sandbox: "danger-full-access"},
                 %{kind: "user", id: "u1"},
                 "t2",
                 name2
               )

      stop_quietly(pid2)
    end

    test "revision_exhausted at the safe-integer ceiling, and the counter never rewinds", %{
      path: path
    } do
      # Seed the ceiling directly into the DETS file (looping ~9e15 times
      # to reach it through submit_request is not feasible) so this pins
      # the boundary check itself, not the accumulation to it.
      max_safe_integer = 9_007_199_254_740_991
      name = :"ps_ceiling_#{System.unique_integer([:positive])}"
      {:ok, table} = :dets.open_file(name, file: String.to_charlist(path <> "_ceiling"))

      entry = %{
        engine: "codex",
        control: %{
          revision: max_safe_integer,
          requested: %{sandbox: "read-only", network_access: false},
          status: :pending,
          submitted: nil,
          effective: nil,
          last_effective: nil,
          reason: nil,
          rolled_back_to: nil,
          actor: nil,
          at: nil,
          constraints: %{approval: "never", enforcement: "os"}
        },
        next: %{
          revision: max_safe_integer,
          requested: %{sandbox: "read-only", network_access: false}
        },
        prior_next: nil
      }

      :ok = :dets.insert(table, {{:counter, "a.ceil"}, max_safe_integer})
      :ok = :dets.insert(table, {{:settings, "a.ceil"}, entry})
      :ok = :dets.close(table)

      name2 = :"ps_ceiling2_#{System.unique_integer([:positive])}"
      {:ok, pid} = PermissionSettings.start_link(name: name2, path: path <> "_ceiling")

      assert PermissionSettings.submit_request(
               "a.ceil",
               "codex",
               %{sandbox: "workspace-write"},
               %{kind: "user", id: "u1"},
               "t",
               name2
             ) == {:error, :revision_exhausted}

      # The rejected attempt must not have moved `next`.
      assert PermissionSettings.get("a.ceil", name2).next.revision == max_safe_integer

      stop_quietly(pid)
      File.rm(path <> "_ceiling")
    end

    test "a DETS write failure returns persistence_failed without crashing the store", %{
      server: server
    } do
      seed_baseline(server, "a.6")
      real_table = :sys.get_state(GenServer.whereis(server)).table

      # `:dets.close/1` from THIS process does not work as a fault
      # injector: dets tracks table users per opening process, so a close
      # issued by a process that never opened the table returns
      # `{:error, :not_owner}` instead of touching the store's own
      # reference (measured). Swap in a table name that was NEVER opened
      # at all instead — the same `:sys.replace_state/2` fault-injection
      # idiom `session_lifecycle_events_test.exs` uses — so the next
      # `:dets.insert` raises ArgumentError (measured: DETS raises on an
      # unusable table name, it does not return an `{:error, _}` tuple;
      # see persist_submit/4's comment). `submit_request/6` is a
      # synchronous `GenServer.call`, unlike SessionLifecycleEvents'
      # cast-based append/5, so the store's own try/rescue in
      # persist_submit/4 is what must convert this into a clean reply —
      # an uncaught raise here would surface as the CALL exiting, not a
      # `{:error, persistence_failed}` value.
      :sys.replace_state(GenServer.whereis(server), fn state ->
        %{state | table: :permission_settings_never_opened}
      end)

      assert PermissionSettings.submit_request(
               "a.6",
               "codex",
               %{sandbox: "workspace-write"},
               %{kind: "user", id: "u1"},
               "t",
               server
             ) == {:error, :persistence_failed}

      assert Process.alive?(GenServer.whereis(server))

      # Restore the real table so `stop_quietly/1` + `File.rm/1` in
      # `on_exit` operate on the actual open handle, not the bogus one.
      :sys.replace_state(GenServer.whereis(server), fn state -> %{state | table: real_table} end)
    end
  end

  # ---- delete: settings vs. counter --------------------------------------

  describe "delete/2" do
    test "removes settings but the revision counter survives, restart included", %{
      server: server,
      path: path
    } do
      seed_baseline(server, "a.7")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "a.7",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      assert PermissionSettings.delete("a.7", server) == :ok
      assert PermissionSettings.get("a.7", server) == nil

      # A deleted agent has no baseline any more, so submit_request alone
      # cannot observe the counter directly — re-seed a baseline (as a
      # respawn under the same agent_id would) and confirm the NEXT
      # accepted request allocates 2, not 1 (the counter was never wiped).
      seed_baseline(server, "a.7")

      assert {:ok, 2, _} =
               PermissionSettings.submit_request(
                 "a.7",
                 "codex",
                 %{sandbox: "danger-full-access"},
                 %{kind: "user", id: "u1"},
                 "t2",
                 server
               )

      :ok = GenServer.stop(server)

      name2 = :"ps_del_restart_#{System.unique_integer([:positive])}"
      {:ok, pid2} = PermissionSettings.start_link(name: name2, path: path)
      seed_baseline(name2, "a.7")

      assert {:ok, 3, _} =
               PermissionSettings.submit_request(
                 "a.7",
                 "codex",
                 %{sandbox: "read-only"},
                 %{kind: "user", id: "u1"},
                 "t3",
                 name2
               )

      stop_quietly(pid2)
    end

    test "delete on an unknown agent is idempotent", %{server: server} do
      assert PermissionSettings.delete("a.none", server) == :ok
    end
  end

  # ---- record_observation -------------------------------------------------

  describe "record_observation/4" do
    test "seeds a fresh baseline when no settings exist yet", %{server: server} do
      seed_baseline(server, "b.1")

      entry = PermissionSettings.get("b.1", server)
      assert entry.engine == "codex"
      assert entry.control.revision == 0
      assert entry.control.status == :pending

      assert entry.next == %{
               revision: 0,
               requested: %{sandbox: "read-only", network_access: false}
             }
    end

    test "an engine change resets control/next but the observation itself does not touch the counter",
         %{server: server} do
      seed_baseline(server, "b.2")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "b.2",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      :ok =
        PermissionSettings.record_observation(
          "b.2",
          "claude-code",
          baseline_control(%{"revision" => 0}),
          server
        )

      :ok = wait_until(fn -> PermissionSettings.get("b.2", server).engine == "claude-code" end)

      entry = PermissionSettings.get("b.2", server)
      assert entry.control.revision == 0
      assert entry.next.revision == 0

      # The counter is untouched by the reset: the next accepted request
      # for this agent_id still continues from 1, i.e. allocates 2.
      assert {:ok, 2, _} =
               PermissionSettings.submit_request(
                 "b.2",
                 "claude-code",
                 %{sandbox: "workspace-write"},
                 %{kind: "user", id: "u1"},
                 "t2",
                 server
               )
    end

    test "malformed shapes are dropped silently, no crash, no state change", %{server: server} do
      seed_baseline(server, "b.3")
      before = PermissionSettings.get("b.3", server)

      :ok =
        PermissionSettings.record_observation(
          "b.3",
          "codex",
          %{"revision" => "not_an_int"},
          server
        )

      :ok = PermissionSettings.record_observation("b.3", "codex", %{}, server)

      # No async op to wait on that would prove a negative; a subsequent
      # synchronous call ordering-guarantees the casts above were
      # processed first.
      assert PermissionSettings.get("b.3", server) == before
    end

    test "a report for an unknown (never-allocated) revision is dropped", %{server: server} do
      seed_baseline(server, "b.4")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "b.4",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      :ok =
        PermissionSettings.record_observation(
          "b.4",
          "codex",
          baseline_control(%{"revision" => 99, "status" => "applied"}),
          server
        )

      entry = PermissionSettings.get("b.4", server)
      assert entry.control.revision == 1
      assert entry.control.status == :pending
    end

    test "an applied observation for the current revision updates control and last_effective", %{
      server: server
    } do
      seed_baseline(server, "b.5")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "b.5",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      effective = %{"session_id" => "s1", "turn_id" => "t1", "execution_id" => "e1"}

      :ok =
        PermissionSettings.record_observation(
          "b.5",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "applied",
            "requested" => %{"sandbox" => "workspace-write", "network_access" => false},
            "effective" => effective
          }),
          server
        )

      :ok = wait_until(fn -> PermissionSettings.get("b.5", server).control.status == :applied end)

      entry = PermissionSettings.get("b.5", server)
      assert entry.control.effective == effective
      assert entry.control.last_effective == effective
    end

    test "a pre-application failure (no submitted ever recorded) rolls next back to the prior selection",
         %{server: server} do
      seed_baseline(server, "b.6")

      {:ok, 1, %{sandbox: "workspace-write"}} =
        PermissionSettings.submit_request(
          "b.6",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      :ok =
        PermissionSettings.record_observation(
          "b.6",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "failed",
            "requested" => %{"sandbox" => "workspace-write", "network_access" => false},
            "reason" => "rejected_by_wrapper"
          }),
          server
        )

      :ok = wait_until(fn -> PermissionSettings.get("b.6", server).control.status == :failed end)

      entry = PermissionSettings.get("b.6", server)
      assert entry.control.status == :failed
      assert entry.control.reason == "rejected_by_wrapper"
      # `next` reverts to the revision-0 baseline, not the rejected pair.
      assert entry.next == %{
               revision: 0,
               requested: %{sandbox: "read-only", network_access: false}
             }
    end

    test "a post-application failure (submitted already recorded) leaves next unchanged", %{
      server: server
    } do
      seed_baseline(server, "b.7")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "b.7",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      submitted = %{"execution_id" => "e1", "revision" => 1}

      :ok =
        PermissionSettings.record_observation(
          "b.7",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "applying",
            "requested" => %{"sandbox" => "workspace-write", "network_access" => false},
            "submitted" => submitted
          }),
          server
        )

      :ok =
        wait_until(fn -> PermissionSettings.get("b.7", server).control.status == :applying end)

      :ok =
        PermissionSettings.record_observation(
          "b.7",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "failed",
            "requested" => %{"sandbox" => "workspace-write", "network_access" => false},
            "reason" => "policy_mismatch"
          }),
          server
        )

      :ok = wait_until(fn -> PermissionSettings.get("b.7", server).control.status == :failed end)

      entry = PermissionSettings.get("b.7", server)
      # submitted survives (merged, not cleared by the failure report).
      assert entry.control.submitted == submitted
      # This was NOT a pre-application rejection, so next is untouched.
      assert entry.next == %{
               revision: 1,
               requested: %{sandbox: "workspace-write", network_access: false}
             }
    end

    test "a delayed applied observation for a superseded revision updates only last_effective",
         %{server: server} do
      seed_baseline(server, "b.8")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "b.8",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t1",
          server
        )

      {:ok, 2, _} =
        PermissionSettings.submit_request(
          "b.8",
          "codex",
          %{sandbox: "danger-full-access"},
          %{kind: "user", id: "u1"},
          "t2",
          server
        )

      effective = %{"session_id" => "s1", "turn_id" => "t1", "execution_id" => "e1"}

      # Revision 1's exec finally reports back after revision 2 already
      # superseded it as the current control/next.
      :ok =
        PermissionSettings.record_observation(
          "b.8",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "applied",
            "requested" => %{"sandbox" => "workspace-write", "network_access" => false},
            "effective" => effective
          }),
          server
        )

      :ok =
        wait_until(fn ->
          PermissionSettings.get("b.8", server).control.last_effective == effective
        end)

      entry = PermissionSettings.get("b.8", server)
      assert entry.control.revision == 2
      assert entry.control.status == :pending
      assert entry.control.last_effective == effective

      # A stale FAILURE (as opposed to applied) must not even update
      # last_effective.
      :ok =
        PermissionSettings.record_observation(
          "b.8",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "failed",
            "requested" => %{"sandbox" => "workspace-write", "network_access" => false},
            "reason" => "stale"
          }),
          server
        )

      # No async signal to prove absence directly; ordering-guarantee via
      # a subsequent synchronous call.
      Process.sleep(20)
      assert PermissionSettings.get("b.8", server) == entry
    end

    # issue #305 (クロエ round 3 N-4): a stale/delayed observation's own
    # self-reported `requested` must never overwrite the ledger's already-
    # recorded historical pair for that revision — that pair is
    # server-authoritative from the moment it is first recorded, exactly
    # like control.requested itself for the CURRENT revision.
    test "a delayed applied observation for a superseded revision does not overwrite the ledger's historical requested pair",
         %{server: server} do
      seed_baseline(server, "b.9")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "b.9",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t1",
          server
        )

      {:ok, 2, _} =
        PermissionSettings.submit_request(
          "b.9",
          "codex",
          %{sandbox: "danger-full-access"},
          %{kind: "user", id: "u1"},
          "t2",
          server
        )

      effective = %{"session_id" => "s1", "turn_id" => "t1", "execution_id" => "e1"}
      forged = %{"sandbox" => "danger-full-access", "network_access" => true}

      :ok =
        PermissionSettings.record_observation(
          "b.9",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "applied",
            "requested" => forged,
            "effective" => effective
          }),
          server
        )

      :ok =
        wait_until(fn ->
          PermissionSettings.get("b.9", server).control.last_effective == effective
        end)

      entry = PermissionSettings.get("b.9", server)
      assert entry.ledger[1].requested == %{sandbox: "workspace-write", network_access: false}
    end
  end

  # ---- M3 ledger (issue #305, ふじ round 1 store-probe findings) -----------

  describe "M3 ledger" do
    test "an unallocated non-zero revision cannot seed a first-ever baseline (M3-a)",
         %{server: server} do
      :ok =
        PermissionSettings.record_observation(
          "c.unallocated",
          "codex",
          baseline_control(%{"revision" => 42}),
          server
        )

      # No entry ever lands — a bogus revision-42 "baseline" would
      # otherwise let a later legitimate submit_request allocate
      # revision 1, landing BELOW it and being misread as stale.
      Process.sleep(20)
      assert PermissionSettings.get("c.unallocated", server) == nil

      assert PermissionSettings.submit_request(
               "c.unallocated",
               "codex",
               %{sandbox: "workspace-write"},
               %{kind: "user", id: "u1"},
               "t",
               server
             ) == {:error, :permission_not_ready}
    end

    test "a same-revision report with a different requested pair is a failed policy mismatch (M-2)",
         %{server: server, path: path} do
      seed_baseline(server, "c.mismatch")

      {:ok, 1, %{sandbox: "workspace-write"}} =
        PermissionSettings.submit_request(
          "c.mismatch",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      forged = %{"sandbox" => "danger-full-access", "network_access" => true}

      forged_effective = %{
        "revision" => 1,
        "requested" => forged,
        "execution_id" => "exec-1",
        "session_id" => "session",
        "turn_id" => "turn-1",
        "permission" => %{"sandbox" => "danger-full-access", "approval" => "never"},
        "network_access" => true
      }

      submitted = %{
        "revision" => 1,
        "requested" => forged,
        "execution_id" => "exec-1"
      }

      :ok =
        PermissionSettings.record_observation(
          "c.mismatch",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "applied",
            "requested" => forged,
            "submitted" => submitted,
            "effective" => forged_effective
          }),
          server
        )

      :ok =
        wait_until(fn ->
          PermissionSettings.get("c.mismatch", server).control.status == :failed
        end)

      entry = PermissionSettings.get("c.mismatch", server)
      assert entry.control.requested == %{sandbox: "workspace-write", network_access: false}
      assert entry.control.status == :failed
      assert entry.control.submitted == submitted
      assert entry.control.reason == "policy_mismatch"
      assert entry.control.effective == forged_effective
      assert entry.control.last_effective == nil
      assert entry.control.rolled_back_to == nil

      assert entry.next == %{
               revision: 1,
               requested: %{sandbox: "workspace-write", network_access: false}
             }

      {control, next} = PermissionSettings.sync_view(entry)
      assert control["status"] == "failed"
      assert control["requested"] == %{"sandbox" => "workspace-write", "network_access" => false}
      assert control["submitted"] == submitted
      assert control["effective"] == forged_effective
      assert control["reason"] == "policy_mismatch"
      refute Map.has_key?(control, "rolled_back_to")
      assert next == entry.next

      probe_name = :"ps_mismatch_probe_#{System.unique_integer([:positive])}"
      {:ok, ^probe_name} = :dets.open_file(probe_name, file: String.to_charlist(path))

      assert [{{:settings, "c.mismatch"}, persisted}] =
               :dets.lookup(probe_name, {:settings, "c.mismatch"})

      assert persisted.control.status == :failed
      assert persisted.next == entry.next
      :dets.close(probe_name)

      :ok = GenServer.stop(server)
      name2 = :"ps_mismatch_restart_#{System.unique_integer([:positive])}"
      {:ok, pid2} = PermissionSettings.start_link(name: name2, path: path)

      reopened = PermissionSettings.get("c.mismatch", name2)
      {reopened_control, reopened_next} = PermissionSettings.sync_view(reopened)
      assert reopened_control == control
      assert reopened_next == next

      GenServer.stop(pid2)
    end

    test "a submitted-less mismatch retains the server-selected next pair", %{server: server} do
      seed_baseline(server, "c.mismatch-no-submitted")

      {:ok, 1, requested} =
        PermissionSettings.submit_request(
          "c.mismatch-no-submitted",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      :ok =
        PermissionSettings.record_observation(
          "c.mismatch-no-submitted",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "applied",
            "requested" => %{"sandbox" => "danger-full-access", "network_access" => true}
          }),
          server
        )

      :ok =
        wait_until(fn ->
          PermissionSettings.get("c.mismatch-no-submitted", server).control.status == :failed
        end)

      entry = PermissionSettings.get("c.mismatch-no-submitted", server)
      assert entry.control.submitted == nil
      assert entry.control.rolled_back_to == nil
      assert entry.next == %{revision: 1, requested: requested}
    end

    test "a mismatch never adopts a WIDER pair via a forged requested (M3-b negative control)",
         %{server: server} do
      seed_baseline(server, "c.mismatch-wide")

      {:ok, 1, %{sandbox: "read-only"}} =
        PermissionSettings.submit_request(
          "c.mismatch-wide",
          "codex",
          %{sandbox: "read-only"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      forged = %{"sandbox" => "danger-full-access", "network_access" => true}

      :ok =
        PermissionSettings.record_observation(
          "c.mismatch-wide",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "applied",
            "requested" => forged,
            "effective" => %{
              "revision" => 1,
              "requested" => forged,
              "execution_id" => "exec-w",
              "session_id" => "session",
              "turn_id" => "turn-1",
              "permission" => %{"sandbox" => "danger-full-access", "approval" => "never"},
              "network_access" => true
            }
          }),
          server
        )

      :ok =
        wait_until(fn ->
          PermissionSettings.get("c.mismatch-wide", server).control.status == :failed
        end)

      entry = PermissionSettings.get("c.mismatch-wide", server)
      # `next` must never be widened to the forged pair, regardless of
      # how the mismatch is reported.
      assert entry.next == %{
               revision: 1,
               requested: %{sandbox: "read-only", network_access: false}
             }
    end

    test "a new request while the prior revision is still applying carries its submitted forward (M3-c)",
         %{server: server} do
      seed_baseline(server, "c.successor")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "c.successor",
          "codex",
          %{sandbox: "workspace-write", network_access: true},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      submitted = %{"revision" => 1, "requested" => %{"sandbox" => "workspace-write"}}

      :ok =
        PermissionSettings.record_observation(
          "c.successor",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "applying",
            "requested" => %{"sandbox" => "workspace-write", "network_access" => true},
            "submitted" => submitted
          }),
          server
        )

      :ok =
        wait_until(fn ->
          PermissionSettings.get("c.successor", server).control.status == :applying
        end)

      {:ok, 2, _} =
        PermissionSettings.submit_request(
          "c.successor",
          "codex",
          %{sandbox: "read-only"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      entry = PermissionSettings.get("c.successor", server)
      assert entry.control.revision == 2
      # protocol.md: "the top-level request is B/pending while submitted
      # ... may describe A" — B's own submit must not wipe A's still
      # in-flight submission.
      assert entry.control.submitted == submitted
    end

    test "a definitive rollback resolves next from the ledger's own prior selection (M3-d)",
         %{server: server} do
      seed_baseline(server, "c.rollback")

      req_a = %{"sandbox" => "workspace-write", "network_access" => true}

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "c.rollback",
          "codex",
          %{sandbox: "workspace-write", network_access: true},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      obs_a = %{
        "revision" => 1,
        "requested" => req_a,
        "execution_id" => "exec-1",
        "session_id" => "session",
        "turn_id" => "turn-1",
        "permission" => %{"sandbox" => "workspace-write", "approval" => "never"},
        "network_access" => true
      }

      sub_a = Map.take(obs_a, ["revision", "requested", "execution_id"])

      :ok =
        PermissionSettings.record_observation(
          "c.rollback",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "applied",
            "requested" => req_a,
            "submitted" => sub_a,
            "effective" => obs_a
          }),
          server
        )

      :ok =
        wait_until(fn ->
          PermissionSettings.get("c.rollback", server).control.status == :applied
        end)

      {:ok, 2, _} =
        PermissionSettings.submit_request(
          "c.rollback",
          "codex",
          %{sandbox: "read-only"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      # Revision 2 is rejected before application; the observation still
      # carries A's lingering `submitted` (protocol.md: "Retain A's
      # submission and request binding"), so `submitted == nil` alone
      # cannot signal the rollback — `rolled_back_to` does.
      :ok =
        PermissionSettings.record_observation(
          "c.rollback",
          "codex",
          baseline_control(%{
            "revision" => 2,
            "status" => "failed",
            "requested" => %{"sandbox" => "read-only", "network_access" => true},
            "submitted" => sub_a,
            "effective" => obs_a,
            "reason" => "rejected_before_application",
            "rolled_back_to" => req_a
          }),
          server
        )

      :ok =
        wait_until(fn ->
          PermissionSettings.get("c.rollback", server).control.status == :failed
        end)

      entry = PermissionSettings.get("c.rollback", server)

      assert entry.next == %{
               revision: 1,
               requested: %{sandbox: "workspace-write", network_access: true}
             }

      # rolled_back_to published to clients/audit is SERVER-derived from
      # the same fallback used for `next`, not the wrapper's raw claim
      # (here they happen to agree; the negative-control test below
      # covers the case where they do NOT).
      assert entry.control.rolled_back_to == %{sandbox: "workspace-write", network_access: true}
      assert entry.control.effective == nil
    end

    test "a rollback never adopts a forged rolled_back_to VALUE, even a wider one (M3-d negative control)",
         %{server: server} do
      seed_baseline(server, "c.rollback-forged")

      req_a = %{"sandbox" => "workspace-write", "network_access" => false}

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "c.rollback-forged",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      obs_a = %{
        "revision" => 1,
        "requested" => req_a,
        "execution_id" => "exec-1",
        "session_id" => "session",
        "turn_id" => "turn-1",
        "permission" => %{"sandbox" => "workspace-write", "approval" => "never"},
        "network_access" => false
      }

      :ok =
        PermissionSettings.record_observation(
          "c.rollback-forged",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "applied",
            "requested" => req_a,
            "submitted" => Map.take(obs_a, ["revision", "requested", "execution_id"]),
            "effective" => obs_a
          }),
          server
        )

      :ok =
        wait_until(fn ->
          PermissionSettings.get("c.rollback-forged", server).control.status == :applied
        end)

      {:ok, 2, _} =
        PermissionSettings.submit_request(
          "c.rollback-forged",
          "codex",
          %{sandbox: "read-only"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      # The wrapper claims rolled_back_to = danger-full-access/true — a
      # WIDER pair than A's actual workspace-write/false, and one that
      # never appears anywhere in this agent's real ledger history.
      forged_rollback = %{"sandbox" => "danger-full-access", "network_access" => true}

      :ok =
        PermissionSettings.record_observation(
          "c.rollback-forged",
          "codex",
          baseline_control(%{
            "revision" => 2,
            "status" => "failed",
            "requested" => %{"sandbox" => "read-only", "network_access" => false},
            "reason" => "rejected_before_application",
            "rolled_back_to" => forged_rollback
          }),
          server
        )

      :ok =
        wait_until(fn ->
          PermissionSettings.get("c.rollback-forged", server).control.status == :failed
        end)

      entry = PermissionSettings.get("c.rollback-forged", server)
      # next/rolled_back_to fall back to the ledger's real prior
      # selection (A), never the forged (and wider) claimed value.
      real_req_a = %{sandbox: "workspace-write", network_access: false}
      assert entry.next == %{revision: 1, requested: real_req_a}
      assert entry.control.rolled_back_to == real_req_a
    end

    test "the ledger prunes oldest settled entries beyond the safety cap", %{server: server} do
      seed_baseline(server, "c.prune")

      for n <- 1..40 do
        sandbox = if rem(n, 2) == 0, do: "workspace-write", else: "read-only"

        {:ok, ^n, _} =
          PermissionSettings.submit_request(
            "c.prune",
            "codex",
            %{sandbox: sandbox},
            %{kind: "user", id: "u1"},
            "t",
            server
          )
      end

      entry = PermissionSettings.get("c.prune", server)
      assert entry.control.revision == 40
      assert map_size(entry.ledger) <= 32
      # The current and next revisions are always protected.
      assert Map.has_key?(entry.ledger, 40)
      # Oldest entries were dropped first.
      refute Map.has_key?(entry.ledger, 1)
    end

    test "a rejected chain retains its eligible selection after pruning", %{server: server} do
      id = "c.rejected-chain-prune"
      actor = %{kind: "user", id: "u1"}
      at = "2026-09-06T00:00:00Z"
      seed_baseline(server, id)

      {:ok, 1, a} =
        PermissionSettings.submit_request(
          id,
          "codex",
          %{sandbox: "workspace-write", network_access: true},
          actor,
          at,
          server
        )

      for revision <- 2..35 do
        sandbox = if rem(revision, 2) == 0, do: "danger-full-access", else: "read-only"

        {:ok, ^revision, requested} =
          PermissionSettings.submit_request(id, "codex", %{sandbox: sandbox}, actor, at, server)

        :ok =
          PermissionSettings.record_observation(
            id,
            "codex",
            baseline_control(%{
              "revision" => revision,
              "requested" => %{
                "sandbox" => requested.sandbox,
                "network_access" => requested.network_access
              },
              "status" => "failed",
              "reason" => "rejected_before_application",
              "rolled_back_to" => %{
                "sandbox" => requested.sandbox,
                "network_access" => requested.network_access
              }
            }),
            server
          )

        :ok =
          wait_until(fn ->
            case PermissionSettings.get(id, server) do
              %{control: %{revision: ^revision, status: :failed}} -> true
              _ -> false
            end
          end)

        assert PermissionSettings.get(id, server).next == %{revision: 1, requested: a}
      end

      entry = PermissionSettings.get(id, server)
      {_control, next} = PermissionSettings.sync_view(entry)

      assert next == %{revision: 1, requested: a}
      assert map_size(entry.ledger) <= 32
      assert Map.has_key?(entry.ledger, 1)
    end

    test "a client_socket: actor id from a retained pre-M1 record does not resurrect on load (M-A)",
         %{server: server, path: path} do
      seed_baseline(server, "c.legacy-actor")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "c.legacy-actor",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      :ok = GenServer.stop(server)

      {:ok, table} = :dets.open_file(server, file: String.to_charlist(path))

      [{{:settings, "c.legacy-actor"}, entry}] =
        :dets.lookup(table, {:settings, "c.legacy-actor"})

      retained_ledger =
        Map.new(2..33, fn revision ->
          {revision,
           %{
             requested: entry.next.requested,
             submitted: nil,
             effective: nil,
             prior_next: %{revision: 1, requested: entry.next.requested}
           }}
        end)

      legacy_entry =
        entry
        |> Map.put(:ledger, Map.merge(entry.ledger, retained_ledger))
        |> put_in([:control, :actor], %{"kind" => "user", "id" => "client_socket:abc123"})

      :dets.insert(table, {{:settings, "c.legacy-actor"}, legacy_entry})
      :dets.sync(table)
      :dets.close(table)

      name2 = :"ps_legacy_actor_#{System.unique_integer([:positive])}"
      {:ok, pid2} = PermissionSettings.start_link(name: name2, path: path)

      assert PermissionSettings.get("c.legacy-actor", name2).control.actor == nil

      GenServer.stop(pid2)
    end

    test "an unknown status survives a restart unchanged, submitted and reason intact (M3-e)",
         %{server: server, path: path} do
      seed_baseline(server, "c.unknown-restart")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "c.unknown-restart",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      submitted = %{"execution_id" => "e1", "revision" => 1}

      :ok =
        PermissionSettings.record_observation(
          "c.unknown-restart",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "unknown",
            "requested" => %{"sandbox" => "workspace-write", "network_access" => false},
            "submitted" => submitted,
            "effective" => %{"execution_id" => "e1", "sandbox" => "workspace-write"},
            "reason" => "observation_unavailable"
          }),
          server
        )

      :ok =
        wait_until(fn ->
          PermissionSettings.get("c.unknown-restart", server).control.status == :unknown
        end)

      :ok = GenServer.stop(server)

      name2 = :"ps_unknown_restart_#{System.unique_integer([:positive])}"
      {:ok, pid2} = PermissionSettings.start_link(name: name2, path: path)

      entry = PermissionSettings.get("c.unknown-restart", name2)
      assert entry.control.status == :unknown
      assert entry.control.submitted == submitted
      assert entry.control.reason == "observation_unavailable"
      assert entry.control.effective == nil

      {control, next} = PermissionSettings.sync_view(entry)
      assert control["status"] == "unknown"
      assert control["submitted"] == submitted
      assert control["reason"] == "observation_unavailable"
      refute Map.has_key?(control, "effective")
      refute Map.has_key?(control, "rolled_back_to")
      assert next == entry.next

      persisted_unknown = %{
        entry
        | control: %{
            entry.control
            | effective: %{"execution_id" => "legacy-e1"},
              rolled_back_to: %{sandbox: "read-only", network_access: false}
          }
      }

      {control, _next} = PermissionSettings.sync_view(persisted_unknown)
      refute Map.has_key?(control, "effective")
      refute Map.has_key?(control, "rolled_back_to")

      GenServer.stop(pid2)
    end
  end

  # ---- sync_view -----------------------------------------------------------

  describe "sync_view/1" do
    test "nil entry projects to {nil, nil}" do
      assert PermissionSettings.sync_view(nil) == {nil, nil}
    end

    test "pending is passed through unchanged (wire-shaped)", %{server: server} do
      seed_baseline(server, "c.1")
      entry = PermissionSettings.get("c.1", server)

      assert PermissionSettings.sync_view(entry) ==
               {PermissionSettings.control_wire(entry.control), entry.next}
    end

    test "applied rounds to pending, drops submitted/effective, keeps last_effective", %{
      server: server
    } do
      seed_baseline(server, "c.2")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "c.2",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      effective = %{"session_id" => "s1", "turn_id" => "t1", "execution_id" => "e1"}

      :ok =
        PermissionSettings.record_observation(
          "c.2",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "applied",
            "requested" => %{"sandbox" => "workspace-write", "network_access" => false},
            "submitted" => %{"execution_id" => "e1"},
            "effective" => effective
          }),
          server
        )

      :ok = wait_until(fn -> PermissionSettings.get("c.2", server).control.status == :applied end)

      entry = PermissionSettings.get("c.2", server)
      {control, next} = PermissionSettings.sync_view(entry)

      assert control["status"] == "pending"
      refute Map.has_key?(control, "submitted")
      refute Map.has_key?(control, "effective")
      assert control["last_effective"] == effective
      assert next == entry.next
    end

    test "failed is never rounded, reason and rolled_back_to survive", %{server: server} do
      seed_baseline(server, "c.3")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "c.3",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      :ok =
        PermissionSettings.record_observation(
          "c.3",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "failed",
            "requested" => %{"sandbox" => "workspace-write", "network_access" => false},
            "reason" => "rejected_by_wrapper",
            "rolled_back_to" => %{"sandbox" => "read-only", "network_access" => false}
          }),
          server
        )

      :ok = wait_until(fn -> PermissionSettings.get("c.3", server).control.status == :failed end)

      entry = PermissionSettings.get("c.3", server)
      {control, _next} = PermissionSettings.sync_view(entry)

      assert control["status"] == "failed"
      assert control["reason"] == "rejected_by_wrapper"
      assert control["rolled_back_to"] == %{"sandbox" => "read-only", "network_access" => false}
    end

    test "optional fields are OMITTED, never emitted as explicit null (issue #305 M1)",
         %{server: server} do
      seed_baseline(server, "c.4")
      entry = PermissionSettings.get("c.4", server)
      {control, _next} = PermissionSettings.sync_view(entry)

      refute Map.has_key?(control, "submitted")
      refute Map.has_key?(control, "effective")
      refute Map.has_key?(control, "last_effective")
      refute Map.has_key?(control, "reason")
      refute Map.has_key?(control, "rolled_back_to")
    end

    test "applying rounds to pending, no explicit null for submitted/effective (issue #305 M1)",
         %{server: server} do
      seed_baseline(server, "c.5")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "c.5",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      submitted = %{"execution_id" => "e1", "revision" => 1}

      :ok =
        PermissionSettings.record_observation(
          "c.5",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "applying",
            "requested" => %{"sandbox" => "workspace-write", "network_access" => false},
            "submitted" => submitted
          }),
          server
        )

      :ok =
        wait_until(fn -> PermissionSettings.get("c.5", server).control.status == :applying end)

      entry = PermissionSettings.get("c.5", server)
      {control, next} = PermissionSettings.sync_view(entry)

      assert control["status"] == "pending"
      refute Map.has_key?(control, "submitted")
      refute Map.has_key?(control, "effective")
      assert next == entry.next
    end

    test "unknown remains blocked with the C parser's wire shape (issue #305 M1)",
         %{server: server} do
      seed_baseline(server, "c.6")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "c.6",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      :ok =
        PermissionSettings.record_observation(
          "c.6",
          "codex",
          baseline_control(%{
            "revision" => 1,
            "status" => "unknown",
            "requested" => %{"sandbox" => "workspace-write", "network_access" => false},
            "submitted" => %{"execution_id" => "e1", "revision" => 1},
            "effective" => %{
              "sandbox" => "workspace-write",
              "network_access" => false,
              "execution_id" => "e1"
            },
            "reason" => "observation_unavailable"
          }),
          server
        )

      :ok =
        wait_until(fn -> PermissionSettings.get("c.6", server).control.status == :unknown end)

      entry = PermissionSettings.get("c.6", server)
      {control, next} = PermissionSettings.sync_view(entry)

      assert control["status"] == "unknown"
      assert control["submitted"] == %{"execution_id" => "e1", "revision" => 1}
      refute Map.has_key?(control, "effective")
      refute Map.has_key?(control, "rolled_back_to")
      assert control["reason"] == "observation_unavailable"
      assert next == entry.next
    end

    # issue #305 M2 (durability): `submit_request/6` must not reply
    # `:ok` until the DETS write is actually durable, so a crash right
    # after a successful reply cannot lose the counter/settings it just
    # promised. Pins the ORDER (counter sync, then settings sync, then
    # reply) rather than reproducing ふじ's real SIGKILL probe
    # (/tmp/fuji305b-r1-evidence/fuji305b-r1-durability.log) in-process —
    # `:dets.sync/1` itself cannot be intercepted from Elixir without
    # replacing the DETS module, so this test instead asserts the
    # documented contract by reading the file position/state directly:
    # after `submit_request/6` returns `:ok`, the counter and settings
    # rows are already flushed to the underlying file, not merely
    # buffered in the DETS server's own write-back cache.
    test "submit_request/6 does not reply until the DETS write is durable (M2)", %{
      server: server,
      path: path
    } do
      seed_baseline(server, "c.durable")

      {:ok, 1, _} =
        PermissionSettings.submit_request(
          "c.durable",
          "codex",
          %{sandbox: "workspace-write"},
          %{kind: "user", id: "u1"},
          "t",
          server
        )

      # A fresh, independent DETS handle on the SAME file sees the
      # just-committed counter/settings rows without going through this
      # store's own in-memory state — proof the write reached disk, not
      # just this GenServer's cache, before submit_request/6 returned.
      probe_name = :"ps_durable_probe_#{System.unique_integer([:positive])}"
      {:ok, ^probe_name} = :dets.open_file(probe_name, file: String.to_charlist(path))

      assert :dets.lookup(probe_name, {:counter, "c.durable"}) == [{{:counter, "c.durable"}, 1}]

      assert [{{:settings, "c.durable"}, settings}] =
               :dets.lookup(probe_name, {:settings, "c.durable"})

      assert settings.control.revision == 1

      :dets.close(probe_name)
    end
  end

  @tag :fuji_r2
  test "consecutive rejected requests retain the last eligible next selection", %{
    server: server,
    path: path
  } do
    id = "fuji.consecutive-rejections"
    seed_baseline(server, id)
    actor = %{kind: "user", id: "u1"}
    at = "2026-09-06T00:00:00Z"

    request = fn patch ->
      PermissionSettings.submit_request(id, "codex", patch, actor, at, server)
    end

    report = fn revision, requested, status, extras ->
      control =
        baseline_control(
          Map.merge(
            %{
              "revision" => revision,
              "requested" => %{
                "sandbox" => requested.sandbox,
                "network_access" => requested.network_access
              },
              "status" => status
            },
            extras
          )
        )

      :ok = PermissionSettings.record_observation(id, "codex", control, server)
      PermissionSettings.get(id, server)
    end

    assert {:ok, 1, a} = request.(%{sandbox: "workspace-write", network_access: true})
    a_wire = %{"sandbox" => a.sandbox, "network_access" => a.network_access}
    submitted = %{"revision" => 1, "requested" => a_wire, "execution_id" => "exec-a"}

    observed =
      Map.merge(submitted, %{
        "session_id" => "session",
        "turn_id" => "turn-a",
        "permission" => %{
          "sandbox" => "workspace-write",
          "approval" => "never",
          "enforcement" => "os"
        },
        "network_access" => true
      })

    report.(1, a, "applied", %{"submitted" => submitted, "effective" => observed})
    assert {:ok, 2, b} = request.(%{sandbox: "danger-full-access"})

    rejection = %{
      "reason" => "rejected_before_application",
      "rolled_back_to" => %{"sandbox" => b.sandbox, "network_access" => b.network_access}
    }

    first = report.(2, b, "failed", rejection)
    assert first.next == %{revision: 1, requested: a}

    assert {:ok, 3, c} = request.(%{sandbox: "read-only"})
    second = report.(3, c, "failed", rejection)
    {control, next} = PermissionSettings.sync_view(second)
    assert next == %{revision: 1, requested: a}
    assert control["rolled_back_to"] == a_wire

    :ok = GenServer.stop(server)
    name = :"ps_rejected_chain_#{System.unique_integer([:positive])}"
    {:ok, pid} = PermissionSettings.start_link(name: name, path: path)

    {control, next} = PermissionSettings.sync_view(PermissionSettings.get(id, name))
    assert next == %{revision: 1, requested: a}
    assert control["rolled_back_to"] == a_wire

    GenServer.stop(pid)
  end

  # issue #305 M-2 (クロエ round 3 S-2): a mismatched report legitimately
  # omits `submitted` when an earlier report already established it for
  # this same revision, so the merged value is what "never submitted"
  # must be read from — the same rule `settled_transition/3` states for
  # its own classification. Without the retention, a wrapper erases its
  # own submission evidence simply by omitting the field.
  test "a submitted-less mismatch keeps the submission an earlier report established",
       %{server: server} do
    id = "c.mismatch-retains-submitted"
    seed_baseline(server, id)

    {:ok, 1, requested} =
      PermissionSettings.submit_request(
        id,
        "codex",
        %{sandbox: "workspace-write"},
        %{kind: "user", id: "u1"},
        "t",
        server
      )

    submitted = %{
      "revision" => 1,
      "requested" => %{"sandbox" => "workspace-write", "network_access" => false},
      "execution_id" => "exec-1"
    }

    :ok =
      PermissionSettings.record_observation(
        id,
        "codex",
        baseline_control(%{
          "revision" => 1,
          "status" => "applying",
          "requested" => %{"sandbox" => "workspace-write", "network_access" => false},
          "submitted" => submitted
        }),
        server
      )

    :ok = wait_until(fn -> PermissionSettings.get(id, server).control.submitted == submitted end)

    :ok =
      PermissionSettings.record_observation(
        id,
        "codex",
        baseline_control(%{
          "revision" => 1,
          "status" => "applied",
          "requested" => %{"sandbox" => "danger-full-access", "network_access" => true}
        }),
        server
      )

    :ok = wait_until(fn -> PermissionSettings.get(id, server).control.status == :failed end)

    entry = PermissionSettings.get(id, server)
    assert entry.control.submitted == submitted
    assert entry.control.reason == "policy_mismatch"
    assert entry.control.rolled_back_to == nil
    assert entry.next == %{revision: 1, requested: requested}
  end
end
