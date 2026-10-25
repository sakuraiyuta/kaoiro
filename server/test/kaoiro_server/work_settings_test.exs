defmodule KaoiroServer.WorkSettingsTest do
  use ExUnit.Case, async: false
  alias KaoiroServer.{WorkSettings, WorkStore}

  @actor %{"kind" => "user", "id" => "settings-operator"}
  @nom "work_nominated_per_principal"
  @active "work_active_per_assignee"
  @corrupt "Work admission is closed because {:settings, :work_capacity} is invalid or has an unsupported schema. The only repair is the offline one-key deletion procedure in docs/reference/configuration/server.md#repair-invalid-work-capacity-settings. Dashboard changes, environment overrides and restoring the pre-repair whole-file backup do not repair it."

  setup do
    old = Application.fetch_env!(:kaoiro_server, :work_store)
    on_exit(fn -> Application.put_env(:kaoiro_server, :work_store, old) end)
    :ok
  end

  defp authorize, do: fn -> {:ok, @actor} end

  defp opid,
    do:
      "op_#{System.system_time(:millisecond)}_#{Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)}"

  defp agent(id), do: %{"kind" => "agent", "id" => id}

  defp nominate(store, director, assignee) do
    op = %{"op" => "assign", "title" => "Nomination", "operation_id" => opid()}
    context = %{recipient: assignee, conversation_id: opid(), turn_number: 1}
    WorkStore.apply(agent(director), op, context, store)
  end

  defp assign(store, assignee) do
    WorkStore.apply(
      @actor,
      %{
        "op" => "assign",
        "title" => "Active",
        "operation_id" => opid(),
        "director" => @actor,
        "assignee" => assignee
      },
      %{operator: true},
      store
    )
  end

  defp store(opts \\ [], seed \\ []) do
    name = String.to_atom("work_settings_#{System.unique_integer([:positive])}")
    root = Path.join(System.tmp_dir!(), "kogane-work-settings-#{name}")
    File.mkdir_p!(root)
    path = Path.join(root, "work.dets")

    if seed != [] do
      {:ok, table} = :dets.open_file(name, file: String.to_charlist(path))
      :ok = :dets.insert(table, seed)
      :ok = :dets.close(table)
    end

    {:ok, sup} =
      Supervisor.start_link([{WorkStore, [name: name, path: path] ++ opts}],
        strategy: :one_for_one
      )

    Process.unlink(sup)

    on_exit(fn ->
      if Process.alive?(sup), do: Supervisor.stop(sup)
      File.rm_rf!(root)
    end)

    {sup, name, path}
  end

  defp restart(sup) do
    :ok = Supervisor.terminate_child(sup, WorkStore)
    {:ok, pid} = Supervisor.restart_child(sup, WorkStore)
    pid
  end

  defp rows(table), do: :dets.foldl(fn row, acc -> [row | acc] end, [], table) |> Enum.sort()

  test "two independent nomination boundaries keep all 16 requests nominated" do
    for direction <- [:director, :assignee] do
      {_sup, name, _path} = store()

      for n <- 1..16 do
        assert {:ok, _} =
                 nominate(
                   name,
                   if(direction == :director, do: "director", else: "director-#{n}"),
                   if(direction == :assignee, do: "target", else: "target-#{n}")
                 )
      end

      works = WorkStore.all(name) |> Map.values()
      assert length(works) == 16
      assert Enum.all?(works, &(&1.state == "nominated"))
      assert Enum.sum(Enum.map(works, &length(&1.receipts))) == 16
      assert Enum.count(works, &(&1.state == "active")) == 0

      assert {:error, {:work_capacity, %{limit: @nom, scope: scope, maximum: 16}}} =
               nominate(
                 name,
                 if(direction == :director, do: "director", else: "new-director"),
                 if(direction == :assignee, do: "target", else: "new-target")
               )

      assert scope == Atom.to_string(direction)
    end
  end

  test "zero skips each admission check; live overrides, no eviction, receipt and restart" do
    {sup, name, _path} = store()

    assert {:ok, %{revision: 0, effective: %{@nom => 16, @active => 16}}} =
             WorkStore.get_settings(authorize(), name)

    assert {:ok, %{revision: 1}} =
             WorkStore.set_settings(authorize(), 0, %{@nom => 0, @active => 0}, name)

    for _ <- 1..17 do
      assert {:ok, _} = nominate(name, "director", "target")
      assert {:ok, _} = assign(name, "active-target")
    end

    nominated = WorkStore.all(name) |> Map.values() |> Enum.find(&(&1.state == "nominated"))

    accept = %{
      "op" => "accept_assignment",
      "work_id" => nominated.work_id,
      "operation_id" => opid()
    }

    context = %{conversation_id: hd(nominated.links), recipient: "director"}
    assert {:ok, _} = WorkStore.apply(agent("target"), accept, context, name)
    count = map_size(WorkStore.all(name))

    assert {:ok, %{revision: 2}} =
             WorkStore.set_settings(authorize(), 1, %{@nom => 1, @active => 1}, name)

    assert map_size(WorkStore.all(name)) == count
    assert {:duplicate, _} = WorkStore.apply(agent("target"), accept, context, name)

    assert {:error, {:work_capacity, %{limit: @active, maximum: 1}}} =
             assign(name, "active-target")

    restart(sup)

    assert {:error, {:work_capacity, %{limit: @nom, maximum: 1}}} =
             nominate(name, "director", "new-target")

    assert {:ok, %{revision: 2, changes: [_, _]}} = WorkStore.get_settings(authorize(), name)

    assert {:ok, %{revision: 3, sources: %{@nom => "default"}}} =
             WorkStore.set_settings(authorize(), 2, %{@nom => nil}, name)
  end

  test "revision check serializes two edits and no-op adds no audit; malformed requests do not block" do
    {_sup, name, _} = store()

    replies =
      for value <- [1, 2],
          do: Task.async(fn -> WorkStore.set_settings(authorize(), 0, %{@nom => value}, name) end)

    replies = Enum.map(replies, &Task.await/1)
    assert Enum.count(replies, &match?({:ok, _}, &1)) == 1
    assert Enum.count(replies, &match?({:error, {:revision_conflict, 1}}, &1)) == 1
    assert {:ok, snapshot} = WorkStore.get_settings(authorize(), name)
    before = rows(name)
    assert {:ok, ^snapshot} = WorkStore.set_settings(authorize(), 1, snapshot.overrides, name)

    for patch <- [
          %{},
          %{"unknown" => 1},
          %{@nom => -1},
          %{@nom => 1.5},
          %{@nom => "0"},
          %{@nom => 2_147_483_648}
        ] do
      assert {:error, :invalid_work_settings} =
               WorkStore.set_settings(authorize(), 1, patch, name)
    end

    assert rows(name) == before
    assert {:ok, _} = assign(name, "target")
  end

  test "audit stays bounded and revision exhaustion cannot wrap or write" do
    {_sup, name, _} = store()

    for revision <- 0..104 do
      assert {:ok, %{revision: next}} =
               WorkStore.set_settings(authorize(), revision, %{@nom => rem(revision, 2)}, name)

      assert next == revision + 1
    end

    assert {:ok, %{revision: 105, changes: changes}} = WorkStore.get_settings(authorize(), name)
    assert length(changes) == 100
    assert Enum.map(changes, & &1.revision) == Enum.to_list(105..6//-1)
    state = :sys.get_state(name)
    ceiling = 9_007_199_254_740_991

    saved = %{
      state.settings
      | revision: ceiling,
        changes: Enum.map(state.settings.changes, &%{&1 | revision: &1.revision + ceiling - 105})
    }

    assert :ok == WorkSettings.validate(saved)
    :ok = :dets.insert(name, {WorkSettings.key(), saved})
    :ok = :dets.sync(name)
    :sys.replace_state(name, &%{&1 | settings: saved})
    before = rows(name)

    assert {:error, :revision_exhausted} =
             WorkStore.set_settings(authorize(), ceiling, %{@nom => 4}, name)

    assert rows(name) == before

    assert {:ok, %{revision: ^ceiling}} =
             WorkStore.set_settings(authorize(), ceiling, saved.overrides, name)

    assert rows(name) == before
  end

  test "zero admission does not disable total records or either global receipt emitter" do
    cfg = Application.fetch_env!(:kaoiro_server, :work_store)

    Application.put_env(
      :kaoiro_server,
      :work_store,
      Keyword.merge(cfg,
        work_nominated_per_principal: 0,
        work_active_per_assignee: 0,
        work_max_records: 1
      )
    )

    {_sup, name, _} = store()
    assert {:ok, _} = assign(name, "first")

    assert {:error, {:work_capacity, %{limit: "work_max_records", scope: "store", maximum: 1}}} =
             assign(name, "second")

    Application.put_env(
      :kaoiro_server,
      :work_store,
      Keyword.merge(cfg,
        work_nominated_per_principal: 0,
        work_active_per_assignee: 0,
        work_receipts_per_principal: 1
      )
    )

    {_sup, name, _} = store()
    assert {:ok, %{work: %{work_id: id}}} = assign(name, "first")

    assert {:error,
            {:work_capacity,
             %{limit: "work_receipts_per_principal", scope: "principal", maximum: 1}}} =
             assign(name, "second")

    assert {:error,
            {:work_capacity,
             %{limit: "work_receipts_per_principal", scope: "principal", maximum: 1}}} =
             WorkStore.apply(
               @actor,
               %{
                 "op" => "revise",
                 "operation_id" => opid(),
                 "work_id" => id,
                 "expected_revision" => 1
               },
               %{operator: true},
               name
             )
  end

  test "finite active assignment counts IDs; acceptance counts complete assignee maps" do
    cfg = Application.fetch_env!(:kaoiro_server, :work_store)

    Application.put_env(
      :kaoiro_server,
      :work_store,
      Keyword.put(cfg, :work_active_per_assignee, 1)
    )

    {_sup, name, _} = store()
    assert {:ok, %{work: %{work_id: active_id}}} = assign(name, "target")
    assert {:ok, %{work: %{work_id: nomination_id}}} = nominate(name, "director", "target")

    :sys.replace_state(name, fn state ->
      work = state.works[active_id]
      altered = %{work | assignee: Map.put(work.assignee, "extra", "different")}
      %{state | works: Map.put(state.works, active_id, altered)}
    end)

    assert {:error, {:work_capacity, %{limit: @active, maximum: 1}}} = assign(name, "target")
    nomination = WorkStore.all(name)[nomination_id]

    assert {:ok, _} =
             WorkStore.apply(
               agent("target"),
               %{
                 "op" => "accept_assignment",
                 "operation_id" => opid(),
                 "work_id" => nomination_id
               },
               %{recipient: "director", conversation_id: hd(nomination.links)},
               name
             )
  end

  test "queued credential recheck rejects an operator revoked while waiting" do
    {_sup, name, _} = store()
    {:ok, credential} = Agent.start_link(fn -> :operator end)

    authorize = fn ->
      if Agent.get(credential, & &1) == :operator, do: {:ok, @actor}, else: {:error, :forbidden}
    end

    :sys.suspend(name)
    task = Task.async(fn -> WorkStore.set_settings(authorize, 0, %{@nom => 0}, name) end)
    # A synchronous system-state query would deadlock while suspended.
    wait_for_queue(Process.whereis(name))
    Agent.update(credential, fn _ -> :viewer end)
    :sys.resume(name)
    assert {:error, :forbidden} = Task.await(task)
    assert [] == :dets.lookup(name, WorkSettings.key())
  end

  defp wait_for_queue(pid, attempts \\ 100)
  defp wait_for_queue(_pid, 0), do: flunk("settings request was not queued")

  defp wait_for_queue(pid, attempts) do
    case Process.info(pid, :message_queue_len) do
      {:message_queue_len, n} when n > 0 ->
        :ok

      _ ->
        Process.sleep(5)
        wait_for_queue(pid, attempts - 1)
    end
  end

  test "invalid stored objects stay alive, preserve all rows and block every authority entry" do
    invalids = [
      :bad,
      %{schema: 2},
      %{WorkSettings.empty() | revision: -1},
      %{WorkSettings.empty() | changes: [:bad]},
      %{WorkSettings.empty() | overrides: %{@nom => 0}}
    ]

    for invalid <- invalids do
      original = {{:settings, :work_capacity}, invalid}
      neighbor = {{:other, "neighbor"}, %{retained: true}}
      {sup, name, _} = store([], [original, neighbor])
      pid = Process.whereis(name)
      assert {:ok, %{restart: :permanent}} = :supervisor.get_childspec(sup, WorkStore)
      assert {:error, :work_settings_corrupt} = WorkStore.get_settings(authorize(), name)
      assert WorkSettings.message(:work_settings_corrupt) == @corrupt

      assert {:error, :work_settings_corrupt} =
               WorkStore.set_settings(authorize(), 0, %{@nom => 0}, name)

      assert {:error, :work_settings_corrupt} =
               WorkStore.set_settings(authorize(), 0, %{@nom => nil}, name)

      for request <- [
            {:apply, @actor, %{}, %{}},
            {:lookup, @actor, opid(), "digest"},
            {:note_delivery, @actor, opid(), %{}, nil},
            {:check, @actor, %{}},
            {:transfer_ack, @actor, "work", "transfer"},
            {:admit_yield, @actor, "a", "c", 1, "w", 1},
            {:authorize_peer_reset, @actor, "target", "w", 1},
            {:claim, @actor, %{}},
            {:drop_yield, "token"},
            :sweep
          ] do
        assert {:error, :work_settings_corrupt} = GenServer.call(name, request)
      end

      assert %{} == WorkStore.all(name)
      WorkStore.status(@actor, nil, name)
      assert [] == WorkStore.yield_tokens("work", name)
      assert rows(name) == Enum.sort([original, neighbor])
      assert Process.whereis(name) == pid
      assert Process.alive?(pid)
      assert :ok = WorkStore.register_modes("agent", self(), [], true, [], name)
      restart(sup)
      assert {:error, :work_settings_corrupt} = WorkStore.get_settings(authorize(), name)
      assert rows(name) == Enum.sort([original, neighbor])
    end
  end

  test "read-side expiration never writes while settings are invalid, even with configured zero" do
    old = Application.fetch_env!(:kaoiro_server, :work_store)

    Application.put_env(
      :kaoiro_server,
      :work_store,
      Keyword.merge(old, work_nominated_per_principal: 0, work_active_per_assignee: 0)
    )

    {sup, name, _} = store()
    assert {:ok, %{work: %{work_id: id}}} = nominate(name, "director", "target")
    work = WorkStore.all(name)[id]
    expired = %{work | updated_at: "2000-01-01T00:00:00Z"}
    :ok = :dets.insert(name, [{{:work, id}, expired}, {WorkSettings.key(), :bad}])
    :ok = :dets.sync(name)
    restart(sup)
    before = rows(name)
    assert {:ok, _} = WorkStore.status(agent("director"), id, name)
    WorkStore.yield_tokens(id, name)
    assert {:error, :work_settings_corrupt} = nominate(name, "director", "target")
    assert rows(name) == before
    assert WorkStore.all(name)[id].state == "nominated"
  end

  test "pre-write invalid and unknown disk state never overwrite or acknowledge" do
    for saved <- [:bad, WorkSettings.empty()] do
      {_sup, name, _} = store()
      :ok = :dets.insert(name, {WorkSettings.key(), saved})
      :ok = :dets.sync(name)
      reason = if saved == :bad, do: :work_settings_corrupt, else: :work_settings_unknown
      pid = Process.whereis(name)
      assert {:error, ^reason} = WorkStore.set_settings(authorize(), 0, %{@nom => 1}, name)
      assert [{_, ^saved}] = :dets.lookup(name, WorkSettings.key())
      assert {:error, ^reason} = assign(name, "target")
      assert Process.whereis(name) == pid
    end
  end

  test "settings I/O failures block without restarting the owner" do
    for fault <- [
          :insert_error,
          :insert_exception,
          :sync_error,
          :read_error,
          :invalid_readback,
          :different_readback
        ] do
      {:ok, control} = Agent.start_link(fn -> false end)

      io = fn action, args ->
        inserted = Agent.get(control, & &1)

        cond do
          action == :insert and fault == :insert_error ->
            {:error, :eio}

          action == :insert and fault == :insert_exception ->
            raise "injected insert failure"

          action == :sync and fault == :sync_error ->
            {:error, :eio}

          action == :lookup and inserted and fault == :read_error ->
            {:error, :eio}

          action == :lookup and inserted and fault == :invalid_readback ->
            [{WorkSettings.key(), :bad}]

          action == :lookup and inserted and fault == :different_readback ->
            []

          true ->
            result = apply(:dets, action, args)
            if action == :insert, do: Agent.update(control, fn _ -> true end)
            result
        end
      end

      {_sup, name, _} = store(test_settings_io: io)
      pid = Process.whereis(name)

      reason =
        if fault == :invalid_readback, do: :work_settings_corrupt, else: :work_settings_unknown

      assert {:error, ^reason} = WorkStore.set_settings(authorize(), 0, %{@nom => 0}, name)
      before = rows(name)
      assert {:error, ^reason} = assign(name, "target")
      assert {:error, ^reason} = WorkStore.set_settings(authorize(), 0, %{@nom => nil}, name)
      assert rows(name) == before
      assert Process.whereis(name) == pid
      assert Process.alive?(pid)
    end
  end

  test "unreadable load and invalid candidate are unknown, not corruption or defaults" do
    {_sup, name, _} = store(test_settings_io: fn _, _ -> {:error, :eio} end)
    assert {:error, :work_settings_unknown} = WorkStore.get_settings(authorize(), name)
    {_sup, name, _} = store(test_settings_candidate: fn _ -> :bad end)

    assert {:error, :work_settings_unknown} =
             WorkStore.set_settings(authorize(), 0, %{@nom => 0}, name)

    assert [] == :dets.lookup(name, WorkSettings.key())
  end

  test "offline one-key repair restores default enforcement; restoring its backup restores corruption" do
    neighbor = {{:other, "neighbor"}, %{retained: true}}
    invalid = {WorkSettings.key(), :bad}
    {sup, name, path} = store([], [neighbor, invalid])
    assert {:error, :work_settings_corrupt} = assign(name, "target")
    :ok = Supervisor.terminate_child(sup, WorkStore)
    backup = path <> ".backup"
    File.cp!(path, backup)
    {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
    :ok = :dets.delete(name, {:settings, :wrong_key})
    :ok = :dets.sync(name)
    assert rows(name) == Enum.sort([neighbor, invalid])
    :ok = :dets.delete(name, {:settings, :work_capacity})
    :ok = :dets.sync(name)
    :ok = :dets.close(name)
    {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
    assert rows(name) == [neighbor]
    :ok = :dets.close(name)
    {:ok, _} = Supervisor.restart_child(sup, WorkStore)

    assert {:ok,
            %{revision: 0, overrides: %{}, changes: [], effective: %{@nom => 16, @active => 16}}} =
             WorkStore.get_settings(authorize(), name)

    for _ <- 1..16, do: assert({:ok, _} = assign(name, "target"))
    assert {:error, {:work_capacity, %{limit: @active, maximum: 16}}} = assign(name, "target")
    :ok = Supervisor.terminate_child(sup, WorkStore)
    File.cp!(backup, path)
    {:ok, _} = Supervisor.restart_child(sup, WorkStore)
    assert {:error, :work_settings_corrupt} = assign(name, "target")
    assert rows(name) == Enum.sort([neighbor, invalid])
  end
end
