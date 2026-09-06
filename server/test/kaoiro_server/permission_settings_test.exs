defmodule KaoiroServer.PermissionSettingsTest do
  use ExUnit.Case, async: true

  import KaoiroServer.TestTeardown

  alias KaoiroServer.PermissionSettings

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
  end

  # ---- sync_view -----------------------------------------------------------

  describe "sync_view/1" do
    test "nil entry projects to {nil, nil}" do
      assert PermissionSettings.sync_view(nil) == {nil, nil}
    end

    test "pending is passed through unchanged", %{server: server} do
      seed_baseline(server, "c.1")
      entry = PermissionSettings.get("c.1", server)

      assert PermissionSettings.sync_view(entry) == {entry.control, entry.next}
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

      assert control.status == :pending
      assert control.submitted == nil
      assert control.effective == nil
      assert control.last_effective == effective
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

      assert control.status == :failed
      assert control.reason == "rejected_by_wrapper"
      assert control.rolled_back_to == %{sandbox: "read-only", network_access: false}
    end
  end
end
