defmodule KaoiroServer.SessionPointerRecoveryTest do
  use KaoiroServerWeb.ChannelCase, async: false

  alias KaoiroServer.{AgentStates, HostRegistry, SessionPointers}

  setup do
    note =
      File.read!(Path.expand("../../../docs/operations/session-pointer-recovery.md", __DIR__))

    [[_, audit], [_, repair]] =
      Regex.scan(~r{/app/bin/kaoiro_server rpc '(.*?)'\n```}s, note)

    host = "recovery.test.#{System.unique_integer([:positive])}"
    cwd = "/confirmed/launch"
    HostRegistry.register(host, %{cwd_allowlist: [cwd]}, self())
    ids = for suffix <- ~w(live offline valid missing no-cwd fresh), do: host <> "." <> suffix
    on_exit(fn -> Enum.each(ids, &SessionPointers.delete/1) end)
    %{audit: audit, repair: repair, host: host, cwd: cwd, ids: ids}
  end

  test "the documented audit flags live, offline, missing-host and nil-cwd rows without writing",
       %{audit: audit, cwd: cwd, ids: [live, offline, valid, _, no_cwd, _]} do
    SessionPointers.record(live, "live-session", "/moved", :claude_code)
    SessionPointers.record(offline, "offline-session", "/moved", :claude_code)
    SessionPointers.record(valid, "valid-session", cwd, :claude_code)
    SessionPointers.record(no_cwd, "no-cwd-session", nil, :claude_code)

    AgentStates.put(%{"agent_id" => live, "state" => "idle", "ts" => "2026-10-02T00:00:00Z"})

    AgentStates.put(%{
      "agent_id" => offline,
      "state" => "disconnected",
      "ts" => "2026-10-02T00:00:00Z"
    })

    missing_host = "absent.recovery.#{System.unique_integer([:positive])}"
    missing_id = missing_host <> ".row"
    SessionPointers.record(missing_id, "missing-session", cwd, :claude_code)
    on_exit(fn -> SessionPointers.delete(missing_id) end)
    before = SessionPointers.all()
    {rows, _} = Code.eval_string(audit)
    by_id = Map.new(rows, &{&1.agent_id, &1})
    assert by_id[live].reason == :cwd_not_allowed
    assert by_id[live].state == "idle"
    assert by_id[offline].reason == :cwd_not_allowed
    assert by_id[offline].state == "disconnected"
    assert by_id[missing_id].reason == :host_not_registered
    assert by_id[missing_id].host_id == missing_host
    assert by_id[no_cwd].reason == :no_cwd
    refute Map.has_key?(by_id, valid)
    assert SessionPointers.all() == before
  end

  test "the documented repair changes only cwd and rejects unverified targets before writing",
       %{audit: audit, repair: repair, cwd: cwd, ids: [id, _, _, _, _, fresh]} do
    SessionPointers.record(id, "exact-session", "/moved", :claude_code)

    SessionPointers.record_snapshot(id, %{
      "model" => "haiku",
      "model_source" => "launch",
      "effort" => "high",
      "effort_source" => "launch"
    })

    before = SessionPointers.get(id)
    expression = repair_expression(repair, id, cwd)
    {after_repair, _} = Code.eval_string(expression)
    assert after_repair == %{before | cwd: cwd}
    assert is_integer(after_repair.effort_revision)
    {rows, _} = Code.eval_string(audit)
    refute Enum.any?(rows, &(&1.agent_id == id))

    assert_raise MatchError, fn ->
      Code.eval_string(repair_expression(repair, id, "/not-allowed"))
    end

    assert SessionPointers.get(id) == after_repair

    assert_raise MatchError, fn ->
      Code.eval_string(repair_expression(repair, "unregistered.recovery.row", cwd))
    end

    assert SessionPointers.get("unregistered.recovery.row") == nil
    SessionPointers.record(fresh, nil, "/moved", :claude_code)
    fresh_before = SessionPointers.get(fresh)
    {fresh_after, _} = Code.eval_string(repair_expression(repair, fresh, cwd))
    assert fresh_after == %{fresh_before | cwd: cwd}
    assert fresh_after.session_id == nil
  end

  defp repair_expression(expression, agent_id, cwd) do
    expression
    |> String.replace("<confirmed-agent-id>", agent_id)
    |> String.replace("<confirmed-launch-cwd>", cwd)
  end
end
