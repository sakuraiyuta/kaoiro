defmodule KaoiroServer.DeliveryPoliciesTest do
  use ExUnit.Case, async: false
  alias KaoiroServer.{DeliveryPolicies, DeliveryPolicyFaultIO, TokenDenylist, WorkStore}
  alias KaoiroServer.DeliveryPolicies.State

  setup do
    name = :"dp_#{System.unique_integer([:positive])}"
    dir = Path.join(System.tmp_dir!(), "fuji559-store-#{System.pid()}-#{name}")
    path = Path.join(dir, "policy.dets")

    on_exit(fn ->
      :persistent_term.erase({DeliveryPolicyFaultIO, name})
      File.rm_rf!(dir)
    end)

    %{name: name, path: path, dir: dir, id: "fuji559-#{name}"}
  end

  defp start(ctx, opts \\ []) do
    start_supervised!({DeliveryPolicies, Keyword.merge([name: ctx.name, path: ctx.path], opts)})
  end

  test "application starts the real default constructor and durably seeds a missing row", ctx do
    assert is_pid(Process.whereis(DeliveryPolicies))

    assert DeliveryPolicies.resolved_path() ==
             Application.fetch_env!(:kaoiro_server, :delivery_policies_path)

    assert {:ok, %{policy: :on, revision: 1}} = DeliveryPolicies.ensure(ctx.id)
    assert {:ok, %{policy: :on, revision: 1}} = DeliveryPolicies.get(ctx.id)
    assert {:ok, stat} = File.stat(DeliveryPolicies.resolved_path())
    assert Bitwise.band(stat.mode, 0o777) == 0o600
  end

  test "CAS has one winner, unchanged values advance, and reopening preserves off", ctx do
    start(ctx)
    assert {:ok, %{revision: 1}} = DeliveryPolicies.ensure(ctx.id, :on, ctx.name)

    tasks =
      for _ <- 1..2,
          do: Task.async(fn -> DeliveryPolicies.compare_and_set(ctx.id, :off, 1, ctx.name) end)

    results = Enum.map(tasks, &Task.await/1)
    assert Enum.count(results, &match?({:ok, %{revision: 2}}, &1)) == 1

    assert Enum.count(
             results,
             &match?({:error, :revision_conflict, %{revision: 2, policy: :off}}, &1)
           ) == 1

    assert {:ok, %{policy: :off, revision: 3}} =
             DeliveryPolicies.compare_and_set(ctx.id, :off, 2, ctx.name)

    stop_supervised!(DeliveryPolicies)
    start(ctx)
    assert {:ok, %{policy: :off, revision: 3}} = DeliveryPolicies.ensure(ctx.id, :on, ctx.name)
  end

  test "revocation blocks late setters, deletion and interrupted cleanup retain allocators",
       ctx do
    start(ctx)
    assert {:ok, %{revision: 1}} = DeliveryPolicies.ensure(ctx.id, :off, ctx.name)
    :ok = TokenDenylist.revoke(ctx.id)
    on_exit(fn -> TokenDenylist.restore(ctx.id) end)
    assert {:error, :policy_unknown} = DeliveryPolicies.compare_and_set(ctx.id, :on, 1, ctx.name)
    assert :ok = DeliveryPolicies.delete(ctx.id, ctx.name)
    assert :dets.lookup(ctx.name, {:counter, ctx.id}) == [{{:counter, ctx.id}, 1}]
    assert {:error, :policy_unknown} = DeliveryPolicies.ensure(ctx.id, :on, ctx.name)
    :ok = TokenDenylist.restore(ctx.id)
    assert {:ok, %{revision: 2}} = DeliveryPolicies.ensure(ctx.id, :off, ctx.name)
    :ok = TokenDenylist.revoke(ctx.id)
    stop_supervised!(DeliveryPolicies)
    start(ctx)
    assert :dets.lookup(ctx.name, {:settings, ctx.id}) == []
    assert :dets.lookup(ctx.name, {:counter, ctx.id}) == [{{:counter, ctx.id}, 2}]
  end

  test "corrupt file stays intact and cannot manufacture an on row", ctx do
    File.mkdir_p!(ctx.dir)
    bytes = "not a dets file; preserve this opt-out evidence"
    File.write!(ctx.path, bytes)
    start(ctx)
    assert {:error, :policy_unknown} = DeliveryPolicies.get(ctx.id, ctx.name)
    assert {:error, :policy_unknown} = DeliveryPolicies.ensure(ctx.id, :on, ctx.name)
    assert File.read!(ctx.path) == bytes
  end

  test "invalid row/counter, exhaustion and malformed revisions fail closed", ctx do
    start(ctx)
    :ok = :dets.insert(ctx.name, {{:settings, ctx.id}, %{policy: :on, revision: 2}})
    assert {:error, :policy_unknown} = DeliveryPolicies.get(ctx.id, ctx.name)
    assert {:error, :policy_unknown} = DeliveryPolicies.compare_and_set(ctx.id, :on, 0, ctx.name)
    :ok = :dets.delete(ctx.name, {:settings, ctx.id})
    :ok = :dets.insert(ctx.name, {{:counter, ctx.id}, 9_007_199_254_740_991})
    assert {:error, :revision_exhausted} = DeliveryPolicies.ensure(ctx.id, :on, ctx.name)

    for bad <- [-1, 0.0, 1.0, "1", 9_007_199_254_740_992] do
      assert {:error, :invalid_payload} = State.change(nil, nil, :off, bad)
    end

    assert {:error, :invalid_payload} = State.change(nil, nil, :unknown, 0)
  end

  test "read and write failures never substitute the cached on; burned counter survives reopen",
       ctx do
    start(ctx, io: DeliveryPolicyFaultIO)
    assert {:ok, %{revision: 1}} = DeliveryPolicies.ensure(ctx.id, :on, ctx.name)
    :persistent_term.put({DeliveryPolicyFaultIO, ctx.name}, :read)
    assert {:error, :policy_unknown} = DeliveryPolicies.get(ctx.id, ctx.name)
    :persistent_term.put({DeliveryPolicyFaultIO, ctx.name}, :row)

    assert {:error, :persistence_failed} =
             DeliveryPolicies.compare_and_set(ctx.id, :off, 1, ctx.name)

    assert {:error, :policy_unknown} = DeliveryPolicies.get(ctx.id, ctx.name)
    :persistent_term.erase({DeliveryPolicyFaultIO, ctx.name})
    stop_supervised!(DeliveryPolicies)
    start(ctx)
    assert {:ok, %{policy: :on, revision: 1}} = DeliveryPolicies.get(ctx.id, ctx.name)

    assert {:ok, %{policy: :off, revision: 3}} =
             DeliveryPolicies.compare_and_set(ctx.id, :off, 1, ctx.name)
  end

  test "sync failure returns no success and leaves future admission unknown", ctx do
    start(ctx, io: DeliveryPolicyFaultIO)
    :persistent_term.put({DeliveryPolicyFaultIO, ctx.name}, :sync)
    assert {:error, :persistence_failed} = DeliveryPolicies.ensure(ctx.id, :on, ctx.name)
    assert {:error, :policy_unknown} = DeliveryPolicies.snapshot(ctx.id, ctx.name)
  end

  test "counter sync precedes row write and row sync precedes asynchronous refresh", ctx do
    parent = self()

    start(ctx,
      test_after_sync: fn stage ->
        send(
          parent,
          {:stage, stage, :dets.lookup(ctx.name, {:settings, ctx.id}),
           :dets.lookup(ctx.name, {:counter, ctx.id})}
        )
      end
    )

    Phoenix.PubSub.subscribe(KaoiroServer.PubSub, "delivery-policy")
    assert {:ok, %{revision: 1}} = DeliveryPolicies.ensure(ctx.id, :off, ctx.name)
    assert_receive {:stage, :counter, [], [{{:counter, _}, 1}]}
    assert_receive {:delivery_policy_refresh, id}
    assert id == ctx.id
    assert_receive {:stage, :row, [{{:settings, _}, %{revision: 1}}], [{{:counter, _}, 1}]}
  end

  test "real DETS trace pins both sync calls in their commit order", ctx do
    pid = start(ctx)
    :erlang.trace_pattern({:dets, :insert, 2}, true, [])
    :erlang.trace_pattern({:dets, :sync, 1}, true, [])
    :erlang.trace(pid, true, [:call, {:tracer, self()}])

    on_exit(fn ->
      :erlang.trace_pattern({:dets, :insert, 2}, false, [])
      :erlang.trace_pattern({:dets, :sync, 1}, false, [])
    end)

    assert {:ok, %{revision: 1}} = DeliveryPolicies.ensure(ctx.id, :off, ctx.name)
    name = ctx.name
    id = ctx.id

    for expected <- [
          {:dets, :insert, [name, {{:counter, id}, 1}]},
          {:dets, :sync, [name]},
          {:dets, :insert, [name, {{:settings, id}, %{policy: :off, revision: 1}}]},
          {:dets, :sync, [name]}
        ] do
      assert_receive {:trace, ^pid, :call, actual}
      assert actual == expected
    end

    :erlang.trace(pid, false, [:call])
  end

  test "owner snapshot clears ack on replacement and old cleanup cannot remove it", ctx do
    start(ctx)
    assert {:ok, %{revision: 1}} = DeliveryPolicies.ensure(ctx.id, :on, ctx.name)
    owner = self()
    modes = %{"early" => "steer", "yield" => "none"}
    :ok = WorkStore.register_delivery(ctx.id, owner, modes, false, nil, true)
    on_exit(fn -> WorkStore.unregister_modes(ctx.id, owner) end)
    assert {:ok, row, snapshot} = DeliveryPolicies.snapshot(ctx.id, ctx.name)
    assert State.denial(row, snapshot) == "policy_unconfirmed"
    :ok = WorkStore.acknowledge_policy(ctx.id, owner, 1)
    assert {:ok, row, snapshot} = DeliveryPolicies.snapshot(ctx.id, ctx.name)
    assert State.denial(row, snapshot) == nil

    replacement =
      spawn(fn ->
        receive do
          :stop -> :ok
        end
      end)

    on_exit(fn ->
      send(replacement, :stop)
      WorkStore.unregister_modes(ctx.id, replacement)
    end)

    :ok = WorkStore.register_delivery(ctx.id, replacement, modes, false, nil, true)
    :ok = WorkStore.unregister_modes(ctx.id, owner)
    assert {:error, :policy_unconfirmed} = WorkStore.acknowledge_policy(ctx.id, owner, 1)
    assert %{owner: ^replacement, applied_revision: nil} = WorkStore.delivery_snapshot(ctx.id)
    assert {:ok, row, snapshot} = DeliveryPolicies.snapshot(ctx.id, ctx.name)
    assert State.denial(row, snapshot) == "policy_unconfirmed"
  end

  test "off and replacement interleaved with a snapshot cannot mix incarnations or rows", ctx do
    ws = :"#{ctx.name}_work"
    start_supervised!({WorkStore, name: ws, path: Path.join(ctx.dir, "work.dets")})
    pid = start(ctx, work_store: ws)
    owner = self()
    modes = %{"early" => "steer", "yield" => "none"}
    :ok = WorkStore.register_delivery(ctx.id, owner, modes, false, nil, true, ws)
    assert {:ok, %{revision: 1}} = DeliveryPolicies.ensure(ctx.id, :on, ctx.name)
    :ok = WorkStore.acknowledge_policy(ctx.id, owner, 1, ws)
    :ok = :sys.suspend(ws)
    :erlang.trace(pid, true, [:send, {:tracer, self()}])
    snapshot = Task.async(fn -> DeliveryPolicies.snapshot(ctx.id, ctx.name) end)
    ws_pid = Process.whereis(ws)
    assert_receive {:trace, ^pid, :send, {:"$gen_call", _, {:delivery_snapshot, _}}, ^ws_pid}
    parent = self()

    setter =
      Task.async(fn ->
        :erlang.trace(self(), true, [:send, {:tracer, parent}])
        DeliveryPolicies.compare_and_set(ctx.id, :off, 1, ctx.name)
      end)

    assert_receive {:trace, _, :send, {:"$gen_call", _, {:cas, _, :off, 1}}, ^pid}

    assert :dets.lookup(ctx.name, {:settings, ctx.id}) == [
             {{:settings, ctx.id}, %{policy: :on, revision: 1}}
           ]

    replacement =
      spawn(fn ->
        receive do
          :stop -> :ok
        end
      end)

    on_exit(fn -> send(replacement, :stop) end)

    register =
      Task.async(fn ->
        WorkStore.register_delivery(ctx.id, replacement, modes, false, nil, true, ws)
      end)

    :ok = :sys.resume(ws)

    assert {:ok, %{policy: :on, revision: 1}, %{owner: ^owner, applied_revision: 1}} =
             Task.await(snapshot)

    assert {:ok, %{policy: :off, revision: 2}} = Task.await(setter)
    assert :ok = Task.await(register)

    assert {:ok, %{policy: :off, revision: 2}, %{owner: ^replacement, applied_revision: nil}} =
             DeliveryPolicies.snapshot(ctx.id, ctx.name)

    :erlang.trace(pid, false, [:send])
  end
end
