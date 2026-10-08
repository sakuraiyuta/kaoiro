defmodule KaoiroServerWeb.ChannelCase do
  @moduledoc """
  Test case for channel tests: imports Phoenix.ChannelTest bound to the
  app endpoint.

  `assert_reply/2..4` is replaced by a macro here. Its default budget is
  `KaoiroServer.TestTimeouts.durable_reply/0`, not ExUnit's
  `assert_receive_timeout`, because many channel replies wait on a DETS
  fsync whose tail passes 100 ms on a loaded host (issues 477 and 479).
  An explicit fourth argument is used as given.
  """

  use ExUnit.CaseTemplate

  using do
    quote do
      import Phoenix.ChannelTest,
        except: [assert_reply: 2, assert_reply: 3, assert_reply: 4]

      import KaoiroServerWeb.ChannelCase

      @endpoint KaoiroServerWeb.Endpoint
    end
  end

  defmacro assert_reply(ref, status) do
    reply_with_budget(
      ref,
      status,
      quote(do: %{}),
      quote(do: KaoiroServer.TestTimeouts.durable_reply())
    )
  end

  defmacro assert_reply(ref, status, payload) do
    reply_with_budget(
      ref,
      status,
      payload,
      quote(do: KaoiroServer.TestTimeouts.durable_reply())
    )
  end

  defmacro assert_reply(ref, status, payload, timeout) do
    reply_with_budget(ref, status, payload, timeout)
  end

  defp reply_with_budget(ref, status, payload, timeout) do
    quote do
      require Phoenix.ChannelTest

      Phoenix.ChannelTest.assert_reply(
        unquote(ref),
        unquote(status),
        unquote(payload),
        unquote(timeout)
      )
    end
  end

  setup do
    # Reset the globally named AgentStates / HostRegistry / TaskStates
    # between tests so stored envelopes, host registrations, and active
    # tasks cannot leak across cases (tests run async: false). TaskStates
    # addition: M4 fix-round (2026-08-09, ふじ review) — tests that
    # exercised the default-named TaskStates singleton via a real channel
    # join (not an isolated `server: name` instance) leaked leftover
    # tasks into whichever test ran next, an order-dependent flake
    # (reproduced with --seed 114834).
    on_exit(fn ->
      Supervisor.terminate_child(KaoiroServer.Supervisor, KaoiroServer.AgentStates)
      Supervisor.restart_child(KaoiroServer.Supervisor, KaoiroServer.AgentStates)
      Supervisor.terminate_child(KaoiroServer.Supervisor, KaoiroServer.HostRegistry)
      Supervisor.restart_child(KaoiroServer.Supervisor, KaoiroServer.HostRegistry)
      Supervisor.terminate_child(KaoiroServer.Supervisor, KaoiroServer.TaskStates)
      Supervisor.restart_child(KaoiroServer.Supervisor, KaoiroServer.TaskStates)
      Supervisor.terminate_child(KaoiroServer.Supervisor, KaoiroServer.PlannedDisconnects)
      Supervisor.restart_child(KaoiroServer.Supervisor, KaoiroServer.PlannedDisconnects)
    end)

    :ok
  end
end
