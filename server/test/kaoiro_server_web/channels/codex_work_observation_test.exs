defmodule KaoiroServerWeb.CodexWorkObservationTest do
  use KaoiroServerWeb.ChannelCase, async: false
  alias KaoiroServer.{CodexBackendCompatibility, HostRegistry, RunnerConnections}
  @registry RunnerConnections.Registry

  defp join_runner(host, register? \\ true) do
    {:ok, _, socket} =
      KaoiroServerWeb.RunnerSocket
      |> socket(nil, %{})
      |> subscribe_and_join(KaoiroServerWeb.RunnerChannel, "runner:" <> host)

    if register?, do: assert_reply(push(socket, "register", %{"cwd_allowlist" => []}), :ok)
    Process.unlink(socket.channel_pid)
    socket
  end

  defp query(host) do
    task = Task.async(fn -> CodexBackendCompatibility.observe_runner(host) end)
    assert_push("observe_codex_work", %{version: "0", schema: 1, request_id: request})
    {task, request}
  end

  defp close_registered(socket) do
    close(socket)
    [{_, partition, :worker, [Registry.Partition]}] = Supervisor.which_children(@registry)
    # Channel exit and Registry's removal notification have different recipients.
    _ = :sys.get_state(partition)
  end

  defp payload(host, request) do
    %{
      "version" => "0",
      "schema" => 1,
      "host" => host,
      "request_id" => request,
      "build_revision" => String.duplicate("a", 40),
      "pid" => 123,
      "instance_id" => "11111111-1111-4111-8111-111111111111",
      "applied_backend" => "exec",
      "children" => [
        %{
          "agent_id" => host <> ".a",
          "stopping" => true,
          "restarting" => true,
          "reset_pending" => true
        }
      ],
      "pending_spawns" => [host <> ".b"],
      "pending_switches" => [host <> ".a"]
    }
  end

  test "default application wires authenticated join, owner RPC and allowlisted response" do
    ids = Enum.map(KaoiroServer.Application.children(), &Supervisor.child_spec(&1, []).id)
    index = fn id -> Enum.find_index(ids, &(&1 == id)) end
    assert index.(@registry) < index.(RunnerConnections)
    assert index.(RunnerConnections) < index.(KaoiroServerWeb.Endpoint)

    for invalid <- [nil, "", "host/name", String.duplicate("a", 257)] do
      assert {:error, :invalid_host_id} = CodexBackendCompatibility.observe_runner(invalid)
    end

    host = "observation-default"
    socket = join_runner(host)
    assert [{owner, nil}] = Registry.lookup(@registry, host)
    assert owner == socket.channel_pid
    assert {:error, :runner_owner_changed} = RunnerConnections.check_owner(host, self())
    {task, request} = query(host)
    value = payload(host, request) |> Map.put("secret", "must-not-project")
    assert_reply(push(socket, "codex_work_observed", value), :ok)
    assert {:ok, result} = Task.await(task)
    assert result["children"] == value["children"]
    assert result["pending_spawns"] == [host <> ".b"]
    assert result["pending_switches"] == [host <> ".a"]
    assert result["owner"] == inspect(owner)
    refute Map.has_key?(result, "secret")
    refute_broadcast("codex_work_observed", _)
  end

  test "joined population includes a second channel before register and changes 0/1/2/1/0" do
    host = "observation-population"
    assert Registry.lookup(@registry, host) == []
    assert {:error, :ambiguous_runner} = CodexBackendCompatibility.observe_runner(host)
    first = join_runner(host)
    assert length(Registry.lookup(@registry, host)) == 1
    second = join_runner(host, false)
    assert length(Registry.lookup(@registry, host)) == 2
    owner = first.channel_pid
    :erlang.trace(owner, true, [:receive])
    assert {:error, :ambiguous_runner} = CodexBackendCompatibility.observe_runner(host)
    refute_receive {:trace, ^owner, :receive, {:"$gen_call", _, {:observe_codex_work, _}}}
    :erlang.trace(owner, false, [:receive])
    refute_push("observe_codex_work", _)
    close_registered(second)
    assert [{_, nil}] = Registry.lookup(@registry, host)
    close_registered(first)
    assert Registry.lookup(@registry, host) == []
  end

  test "a second request is busy without overwriting the first caller" do
    host = "observation-busy"
    socket = join_runner(host)
    {first, request} = query(host)
    pending = :sys.get_state(socket.channel_pid).assigns.codex_observation
    assert {:error, :runner_observation_busy} = CodexBackendCompatibility.observe_runner(host)
    assert_reply(push(socket, "codex_work_observed", payload(host, request)), :ok)
    assert {:ok, _} = Task.await(first)
    assert :erlang.read_timer(pending.timer) == false
    assert {:monitors, monitors} = Process.info(socket.channel_pid, :monitors)
    refute {:process, first.pid} in monitors
  end

  test "push checks ownership, disconnect releases the caller, and expired replies refuse" do
    host = "observation-boundaries"
    socket = join_runner(host)
    :ok = HostRegistry.register(host, %{policy: :accept_all, cwd_allowlist: []}, self())

    assert {:error, :ambiguous_runner} =
             GenServer.call(socket.channel_pid, {:observe_codex_work, "request"})

    refute_push("observe_codex_work", _)
    assert_reply(push(socket, "register", %{"cwd_allowlist" => []}), :ok)
    {task, request} = query(host)

    :sys.replace_state(socket.channel_pid, fn state ->
      put_in(state.assigns.codex_observation.deadline, System.monotonic_time(:millisecond) - 1)
    end)

    assert_reply(push(socket, "codex_work_observed", payload(host, request)), :ok)
    assert {:error, :runner_observation_timeout} = Task.await(task)
    {task, _} = query(host)
    close(socket)
    assert {:error, :runner_observation_disconnected} = Task.await(task)
  end

  test "missing boot identity and failed registration cannot become an empty observation" do
    Process.flag(:trap_exit, true)
    assert :ok = KaoiroServerWeb.RunnerChannel.terminate(:normal, %Phoenix.Socket{})
    epoch = {RunnerConnections, :boot_identity}
    previous = :persistent_term.get(epoch)

    try do
      :persistent_term.erase(epoch)

      assert {:error, :runner_registry_changed} =
               CodexBackendCompatibility.observe_runner("missing")
    after
      :persistent_term.put(epoch, previous)
    end

    :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, @registry)

    try do
      assert {:error, %{reason: "runner_connections_unavailable"}} =
               KaoiroServerWeb.RunnerSocket
               |> socket(nil, %{})
               |> subscribe_and_join(KaoiroServerWeb.RunnerChannel, "runner:unregistered")
    after
      {:ok, _} = Supervisor.restart_child(KaoiroServer.Supervisor, @registry)
      # Only the application restart may establish the new baseline.
      :ok = Application.stop(:kaoiro_server)
      {:ok, _} = Application.ensure_all_started(:kaoiro_server)
    end
  end

  test "old event consumers time out, then accept another request; caller death also releases the slot" do
    host = "observation-timeout"
    socket = join_runner(host)
    {task, old} = query(host)
    assert {:error, :runner_observation_timeout} = Task.await(task, 6_000)
    {task, request} = query(host)
    assert request != old
    assert_reply(push(socket, "codex_work_observed", payload(host, old)), :ok)
    assert {:error, :invalid_runner_observation} = Task.await(task)
    {task, _} = query(host)
    Task.shutdown(task, :brutal_kill)
    _ = :sys.get_state(socket.channel_pid)
    {last, request} = query(host)
    assert_reply(push(socket, "codex_work_observed", payload(host, request)), :ok)
    assert {:ok, _} = Task.await(last)
  end

  test "response arrival and RPC return both fence owner changes" do
    host = "observation-owner"
    socket = join_runner(host)
    {task, request} = query(host)
    :erlang.suspend_process(task.pid)

    try do
      :ok = HostRegistry.register(host, %{policy: :accept_all, cwd_allowlist: []}, self())
      assert_reply(push(socket, "codex_work_observed", payload(host, request)), :ok)
      assert_reply(push(socket, "register", %{"cwd_allowlist" => []}), :ok)
    after
      :erlang.resume_process(task.pid)
    end

    assert {:error, :ambiguous_runner} = Task.await(task)

    assert_reply(push(socket, "register", %{"cwd_allowlist" => []}), :ok)
    {task, request} = query(host)
    :erlang.suspend_process(task.pid)

    try do
      assert_reply(push(socket, "codex_work_observed", payload(host, request)), :ok)
      :ok = HostRegistry.register(host, %{policy: :accept_all, cwd_allowlist: []}, self())
    after
      :erlang.resume_process(task.pid)
    end

    assert {:error, :ambiguous_runner} = Task.await(task)
  end

  test "a new join while waiting makes even an empty owner response unavailable" do
    host = "observation-race"
    socket = join_runner(host)
    {task, request} = query(host)
    _second = join_runner(host, false)

    value =
      Map.merge(payload(host, request), %{
        "children" => [],
        "pending_spawns" => [],
        "pending_switches" => []
      })

    assert_reply(push(socket, "codex_work_observed", value), :ok)
    assert {:error, :ambiguous_runner} = Task.await(task)
  end

  test "each invalid element rejects the whole response instead of filtering it" do
    host = "observation-invalid"
    socket = join_runner(host)

    for {key, invalid} <-
          [
            {"host", "other"},
            {"schema", 2},
            {"version", "1"},
            {"build_revision", "unknown"},
            {"pid", 0},
            {"instance_id", ""},
            {"applied_backend", "other"},
            {"children",
             [
               %{
                 "agent_id" => host <> ".a",
                 "stopping" => "false",
                 "restarting" => false,
                 "reset_pending" => false
               }
             ]},
            {"pending_spawns", [host <> ".a", "other.a"]},
            {"pending_spawns", [host <> ".a", host <> ".a"]},
            {"pending_switches", [host <> ".nested.a"]},
            {"pending_switches", [String.duplicate("a", 257)]},
            {"pending_switches", [host <> ".a/invalid"]},
            {"pending_switches", [nil]}
          ] ++
            [
              {"children",
               [
                 %{
                   "agent_id" => "other.a",
                   "stopping" => false,
                   "restarting" => false,
                   "reset_pending" => false
                 }
               ]},
              {"children",
               List.duplicate(
                 %{
                   "agent_id" => host <> ".a",
                   "stopping" => false,
                   "restarting" => false,
                   "reset_pending" => false
                 },
                 2
               )}
            ] do
      {task, request} = query(host)

      assert_reply(
        push(socket, "codex_work_observed", Map.put(payload(host, request), key, invalid)),
        :ok
      )

      assert {:error, :invalid_runner_observation} = Task.await(task),
             "accepted #{key}: #{inspect(invalid)}"
    end
  end

  test "external_size 65536 passes and 65537 refuses without truncation" do
    host = "observation-size"
    socket = join_runner(host)

    for size <- [65_536, 65_537] do
      {task, request} = query(host)
      value = Map.put(payload(host, request), "padding", "")

      value =
        Map.put(value, "padding", String.duplicate("x", size - :erlang.external_size(value)))

      assert :erlang.external_size(value) == size
      assert_reply(push(socket, "codex_work_observed", value), :ok)
      result = Task.await(task)

      if size == 65_536,
        do: assert({:ok, _} = result),
        else: assert(result == {:error, :payload_too_large})
    end
  end

  test "partition replacement refuses until the entire application restarts" do
    Process.flag(:trap_exit, true)
    on_exit(fn -> Application.ensure_all_started(:kaoiro_server) end)

    # This is a tripwire for Registry's partition layout and link semantics across Elixir upgrades.
    for reason <- [:normal, :kill] do
      host = "observation-epoch"
      socket = join_runner(host)
      other = join_runner("observation-other")
      other_down = Process.monitor(other.channel_pid)
      Process.unlink(socket.channel_pid)
      channel_down = Process.monitor(socket.channel_pid)
      [{_id, partition, :worker, [Registry.Partition]}] = Supervisor.which_children(@registry)
      partition_down = Process.monitor(partition)

      if reason == :normal do
        :ok = GenServer.stop(partition, :normal)
        refute_receive {:DOWN, ^channel_down, :process, _, _}
        refute_receive {:DOWN, ^other_down, :process, _, _}
        assert Registry.lookup(@registry, host) == []
      else
        Process.exit(partition, :kill)
      end

      assert_receive {:DOWN, ^partition_down, :process, ^partition, _}
      if reason == :kill, do: assert_receive({:DOWN, ^channel_down, :process, _, _})
      if reason == :kill, do: assert_receive({:DOWN, ^other_down, :process, _, _})
      assert {:error, :runner_registry_changed} = CodexBackendCompatibility.observe_runner(host)
      :ok = Application.stop(:kaoiro_server)
      if reason == :normal, do: assert_receive({:DOWN, ^channel_down, :process, _, _})
      if reason == :normal, do: assert_receive({:DOWN, ^other_down, :process, _, _})
      {:ok, _} = Application.ensure_all_started(:kaoiro_server)
      socket = join_runner(host)
      {task, request} = query(host)
      assert_reply(push(socket, "codex_work_observed", payload(host, request)), :ok)
      assert {:ok, _} = Task.await(task)
      close(socket)
    end
  end
end
