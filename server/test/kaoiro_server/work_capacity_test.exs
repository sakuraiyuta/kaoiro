defmodule KaoiroServer.WorkCapacityTest do
  use ExUnit.Case, async: false
  alias KaoiroServer.WorkStore

  @actor %{"kind" => "user", "id" => "capacity-operator"}

  setup do
    old = Application.fetch_env!(:kaoiro_server, :work_store)
    on_exit(fn -> Application.put_env(:kaoiro_server, :work_store, old) end)
    :ok
  end

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

  defp store do
    name = String.to_atom("work_capacity_#{System.unique_integer([:positive])}")
    root = Path.join(System.tmp_dir!(), "kaoiro-work-capacity-#{name}")
    File.mkdir_p!(root)
    path = Path.join(root, "work.dets")

    {:ok, sup} =
      Supervisor.start_link([{WorkStore, [name: name, path: path]}],
        strategy: :one_for_one
      )

    Process.unlink(sup)

    on_exit(fn ->
      KaoiroServer.TestTeardown.stop_quietly(sup)
      File.rm_rf!(root)
    end)

    {sup, name, path}
  end

  test "the default store-wide record cap refuses the next assign" do
    {sup, name, path} = store()
    assert {:ok, %{work: %{work_id: id}}} = assign(name, "first")
    template = %{WorkStore.all(name)[id] | receipts: []}
    maximum = Application.fetch_env!(:kaoiro_server, :work_store)[:work_max_records]
    assert maximum == 4_096
    :ok = Supervisor.terminate_child(sup, WorkStore)
    {:ok, table} = :dets.open_file(name, file: String.to_charlist(path))

    clones =
      for i <- 2..maximum do
        clone_id = "wrk_clone_#{i}"
        {{:work, clone_id}, %{template | work_id: clone_id}}
      end

    :ok = :dets.insert(table, clones)
    :ok = :dets.close(table)
    {:ok, _pid} = Supervisor.restart_child(sup, WorkStore)
    assert map_size(WorkStore.all(name)) == maximum

    assert {:error,
            {:work_capacity, %{limit: "work_max_records", scope: "store", maximum: ^maximum}}} =
             assign(name, "next")
  end

  test "a configured store-wide record cap and the global receipt cap refuse" do
    cfg = Application.fetch_env!(:kaoiro_server, :work_store)
    Application.put_env(:kaoiro_server, :work_store, Keyword.put(cfg, :work_max_records, 1))

    {_sup, name, _} = store()
    assert {:ok, _} = assign(name, "first")

    assert {:error, {:work_capacity, %{limit: "work_max_records", scope: "store", maximum: 1}}} =
             assign(name, "second")

    Application.put_env(
      :kaoiro_server,
      :work_store,
      Keyword.put(cfg, :work_receipts_per_principal, 1)
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
                 "op" => "complete",
                 "operation_id" => opid(),
                 "work_id" => id,
                 "expected_revision" => 1
               },
               %{operator: true},
               name
             )
  end

  defp operate(
         name,
         id,
         operation,
         extra \\ %{},
         principal \\ @actor,
         context \\ %{operator: true}
       ) do
    work = WorkStore.all(name)[id]

    args =
      Map.merge(
        %{
          "op" => operation,
          "operation_id" => opid(),
          "work_id" => id,
          "expected_revision" => work.revision,
          "basis_revision" => work.revision
        },
        extra
      )

    WorkStore.apply(principal, args, context, name)
  end

  test "per-work receipt capacity refuses on its own" do
    cfg = Application.fetch_env!(:kaoiro_server, :work_store)

    Application.put_env(
      :kaoiro_server,
      :work_store,
      Keyword.put(cfg, :work_receipts_per_work_principal, 1)
    )

    {_sup, name, _} = store()
    assert {:ok, %{work: %{work_id: id}}} = assign(name, "receipt")

    assert {:error,
            {:work_capacity,
             %{limit: "work_receipts_per_work_principal", scope: "work_principal", maximum: 1}}} =
             operate(name, id, "complete")
  end

  test "link capacity is distinct from assign-link conflict and conversation closure does not decline" do
    {_sup, name, _} = store()
    assert {:ok, %{work: %{work_id: id}}} = nominate(name, "director", "target")
    original = hd(WorkStore.all(name)[id].links)

    assert {:error, :work_link_conflict} =
             WorkStore.apply(
               agent("director"),
               %{"op" => "assign", "operation_id" => opid(), "title" => "Conflicting link"},
               %{recipient: "target", conversation_id: original, turn_number: 1},
               name
             )

    tracker = String.to_atom("work_capacity_conversations_#{System.unique_integer([:positive])}")
    start_supervised!({KaoiroServer.ConversationStates, name: tracker})

    assert :ok =
             KaoiroServer.ConversationStates.record_message(
               original,
               "director",
               "target",
               "nomination",
               1,
               false,
               true,
               tracker
             )

    assert {:ok, _} = KaoiroServer.ConversationStates.close_by_operator(original, tracker)
    assert WorkStore.all(name)[id].state == "nominated"

    assert {:ok, _} =
             operate(name, id, "accept_assignment", %{}, agent("target"), %{
               recipient: "director",
               conversation_id: original
             })

    for _ <- 1..31 do
      assert {:ok, _} =
               WorkStore.link(
                 agent("director"),
                 id,
                 %{
                   recipient: "target",
                   conversation_id: opid(),
                   new_conversation?: true
                 },
                 name
               )
    end

    assert length(WorkStore.all(name)[id].links) == 32

    assert {:error, {:work_capacity, %{limit: "work_links_per_work", scope: "work", maximum: 32}}} =
             WorkStore.link(
               agent("director"),
               id,
               %{
                 recipient: "target",
                 conversation_id: opid(),
                 new_conversation?: true
               },
               name
             )
  end
end
