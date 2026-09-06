defmodule KaoiroServer.QuagmireSettingsTest do
  use ExUnit.Case, async: true

  import KaoiroServer.TestTeardown

  alias KaoiroServer.QuagmireSettings
  alias KaoiroServer.QuagmireWatch

  setup do
    # Isolated DETS file + table name per test so cases don't share state.
    name = :"qs_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
    File.rm(path)
    {:ok, pid} = QuagmireSettings.start_link(name: name, path: path)

    on_exit(fn ->
      stop_quietly(pid)
      File.rm(path)
    end)

    %{server: name, path: path}
  end

  # The fallback must be the value the detector itself boots on; asserting a
  # literal 16 here would pass while the two had drifted apart.
  test "with nothing stored it reports the detector's own boot threshold", %{server: server} do
    assert QuagmireSettings.rally_turns(server) ==
             QuagmireWatch.configured_settings().rally_turns

    assert %{source: :default} = QuagmireSettings.effective(server)
  end

  test "a stored pick wins over the boot value", %{server: server} do
    assert :ok = QuagmireSettings.put_rally_turns(40, server)

    assert QuagmireSettings.rally_turns(server) == 40
    assert QuagmireSettings.effective(server) == %{rally_turns: 40, source: :stored}
  end

  test ":off is storable and distinct from a number", %{server: server} do
    assert :ok = QuagmireSettings.put_rally_turns(:off, server)

    assert QuagmireSettings.rally_turns(server) == :off
    assert QuagmireSettings.effective(server) == %{rally_turns: :off, source: :stored}
  end

  test "the maximum is accepted and one past it is not", %{server: server} do
    max = QuagmireSettings.max_rally_turns()

    assert :ok = QuagmireSettings.put_rally_turns(max, server)
    assert {:error, :invalid_rally_turns} = QuagmireSettings.put_rally_turns(max + 1, server)
    assert QuagmireSettings.rally_turns(server) == max
  end

  # A rejected value must leave the previous pick standing: a threshold
  # silently reset by a malformed request is worse than a refused change.
  test "rejects every non-threshold and keeps the previous pick", %{server: server} do
    assert :ok = QuagmireSettings.put_rally_turns(24, server)

    for bad <- [0, -1, 16.0, "16", nil, :on, %{}, [16]] do
      assert {:error, :invalid_rally_turns} = QuagmireSettings.put_rally_turns(bad, server),
             "expected #{inspect(bad)} to be rejected"
    end

    assert QuagmireSettings.rally_turns(server) == 24
  end

  # A restart test cannot see this: closing the table on a clean shutdown
  # flushes, so a missing `:dets.sync/1` still reads back correctly there.
  # A second handle opened while the store is STILL RUNNING sees only what
  # is on disk at that instant.
  test "the pick is on disk before put_rally_turns replies", %{server: server, path: path} do
    assert :ok = QuagmireSettings.put_rally_turns(37, server)

    probe = :"qs_durable_probe_#{System.unique_integer([:positive])}"
    {:ok, ^probe} = :dets.open_file(probe, file: String.to_charlist(path))
    persisted = :dets.lookup(probe, :rally_turns)
    :dets.close(probe)

    assert persisted == [{:rally_turns, 37}]
  end

  test "clear removes the pick from disk before it replies", %{server: server, path: path} do
    assert :ok = QuagmireSettings.put_rally_turns(37, server)
    assert :ok = QuagmireSettings.clear(server)

    probe = :"qs_clear_probe_#{System.unique_integer([:positive])}"
    {:ok, ^probe} = :dets.open_file(probe, file: String.to_charlist(path))
    persisted = :dets.lookup(probe, :rally_turns)
    :dets.close(probe)

    assert persisted == []
  end

  test "clear drops the pick and restores the boot value", %{server: server} do
    assert :ok = QuagmireSettings.put_rally_turns(40, server)
    assert :ok = QuagmireSettings.clear(server)

    assert QuagmireSettings.rally_turns(server) ==
             QuagmireWatch.configured_settings().rally_turns

    assert %{source: :default} = QuagmireSettings.effective(server)
    assert :ok = QuagmireSettings.clear(server)
  end

  test "the pick survives a restart of the store", %{server: server, path: path} do
    assert :ok = QuagmireSettings.put_rally_turns(48, server)
    stop_quietly(server)

    {:ok, pid} = QuagmireSettings.start_link(name: server, path: path)
    on_exit(fn -> stop_quietly(pid) end)

    assert QuagmireSettings.rally_turns(server) == 48
    assert %{source: :stored} = QuagmireSettings.effective(server)
  end

  # The write path is not the only way into the file. A value that got in by
  # another route must not become the live threshold.
  test "discards a malformed persisted value and falls back", %{server: server, path: path} do
    stop_quietly(server)

    table = :"#{server}_seed"
    {:ok, ^table} = :dets.open_file(table, file: String.to_charlist(path))
    :ok = :dets.insert(table, {:rally_turns, -5})
    :ok = :dets.close(table)

    {:ok, pid} = QuagmireSettings.start_link(name: server, path: path)
    on_exit(fn -> stop_quietly(pid) end)

    assert QuagmireSettings.rally_turns(server) ==
             QuagmireWatch.configured_settings().rally_turns

    assert %{source: :default} = QuagmireSettings.effective(server)
  end

  # `source` is resolved once at init, so this asserts the boot-time read —
  # not that config and the environment agree at this instant (runtime.exs
  # is what makes them agree on a real boot).
  test "names the environment as the source when it set the boot default" do
    name = :"qs_env_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
    File.rm(path)

    System.put_env("KAOIRO_QUAGMIRE_RALLY_TURNS", "21")
    {:ok, pid} = QuagmireSettings.start_link(name: name, path: path)

    on_exit(fn ->
      System.delete_env("KAOIRO_QUAGMIRE_RALLY_TURNS")
      stop_quietly(pid)
      File.rm(path)
    end)

    assert %{source: :env} = QuagmireSettings.effective(name)
  end
end
