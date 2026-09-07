defmodule KaoiroServer.ApplicationChildrenTest do
  # Reads and briefly removes an application env key, and asks the running
  # supervision tree what it has.
  use ExUnit.Case, async: false

  alias KaoiroServer.Application, as: App

  @watch_spec {KaoiroServer.QuagmireWatch, on_notice: &App.broadcast_quagmire_notice/1}

  # issue #320. QuagmireWatch sweeps on a 60-second wall clock and is the
  # only path by which a `quagmire_notice` reaches `agents:lobby`. Under
  # `mix test` that timer crosses test boundaries: a conversation one test
  # closed past the rally threshold is broadcast into whatever socket a
  # LATER test has joined, which failed that test's `refute_push` in roughly
  # 1 run in 30.
  test "the test node runs no detector" do
    assert Process.whereis(KaoiroServer.QuagmireWatch) == nil

    ids =
      KaoiroServer.Supervisor
      |> Supervisor.which_children()
      |> Enum.map(&elem(&1, 0))

    refute KaoiroServer.QuagmireWatch in ids

    # Guards the check above: an empty tree would satisfy it while measuring
    # nothing.
    assert KaoiroServer.QuagmireSettings in ids
  end

  # The production path, checked without starting the application twice.
  test "production runs the detector, wired to the real broadcast" do
    assert @watch_spec in App.children(true)
    refute @watch_spec in App.children(false)
  end

  test "the flag defaults to ON when nothing configures it" do
    prior = Application.get_env(:kaoiro_server, :start_quagmire_watch)
    Application.delete_env(:kaoiro_server, :start_quagmire_watch)

    on_exit(fn -> Application.put_env(:kaoiro_server, :start_quagmire_watch, prior) end)

    assert App.quagmire_watch_enabled?()
  end
end
