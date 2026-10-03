defmodule KaoiroServer.AgentStatesVisibilityTest do
  # AgentStates announces an agent that turns from hidden to visible for
  # viewers, from the one place the agents map is written (issue 482 design r3b
  # A1, r3c C1). The two callbacks are doubles here; the production predicate
  # has its own cases at the end.
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias KaoiroServer.AgentStates
  alias KaoiroServerWeb.StatusLineVisibility

  defp env(id, type, extra \\ %{}) do
    Map.merge(%{"agent_id" => id, "type" => type, "state" => "idle", "ts" => "t0"}, extra)
  end

  defp visible_env(id, extra \\ %{}), do: env(id, "state_change", extra)
  defp hidden_env(id, extra \\ %{}), do: env(id, "instruction_rejected", extra)

  # `visible?` counts its calls to the test and reads the type; the announcement
  # goes to the test too. Both run in the AgentStates process.
  defp start(overrides \\ []) do
    parent = self()

    visible? = fn envelope ->
      send(parent, {:visible?, envelope && envelope["type"]})
      envelope != nil and envelope["type"] == "state_change"
    end

    opts =
      Keyword.merge(
        [
          name: :"agent_states_vis_#{System.unique_integer([:positive])}",
          visible?: visible?,
          on_viewer_visible: fn agent_id -> send(parent, {:announce, agent_id}) end
        ],
        overrides
      )

    store = start_supervised!({AgentStates, opts})
    %{store: store, name: opts[:name]}
  end

  defp put(ctx, envelope, owner \\ nil),
    do: AgentStates.put(envelope, server: ctx.name, owner: owner)

  defp drain do
    receive do
      _ -> drain()
    after
      0 -> :ok
    end
  end

  describe "put" do
    test "announces hidden to visible once, and not visible to visible" do
      ctx = start()

      assert :ok = put(ctx, hidden_env("a.one"))
      refute_received {:announce, _}

      assert :ok = put(ctx, visible_env("a.one"))
      assert_received {:announce, "a.one"}

      assert :ok = put(ctx, visible_env("a.one", %{"ts" => "t1"}))
      refute_received {:announce, _}
    end

    test "does not announce hidden to hidden or visible to hidden, and announces again after" do
      ctx = start()

      put(ctx, visible_env("a.one"))
      assert_received {:announce, "a.one"}
      put(ctx, hidden_env("a.one"))
      put(ctx, hidden_env("a.one", %{"ts" => "t2"}))
      refute_received {:announce, _}

      put(ctx, visible_env("a.one", %{"ts" => "t3"}))
      assert_received {:announce, "a.one"}
    end

    test "a new entry announces when its first envelope is visible, and not when it is hidden" do
      ctx = start()

      put(ctx, hidden_env("a.hidden"))
      refute_received {:announce, _}

      put(ctx, visible_env("a.new"))
      assert_received {:announce, "a.new"}
    end
  end

  describe "the other writers of the slot" do
    test "disconnect announces an agent whose latest envelope was hidden" do
      ctx = start()
      owner = self()

      put(ctx, hidden_env("a.one"), owner)
      refute_received {:announce, _}

      assert {:ok, %{"state" => "disconnected"}} =
               AgentStates.disconnect("a.one", owner, "t9", server: ctx.name)

      assert_received {:announce, "a.one"}
    end

    test "disconnect from a visible latest envelope does not announce" do
      ctx = start()
      owner = self()

      put(ctx, visible_env("a.one"), owner)
      assert_received {:announce, "a.one"}

      assert {:ok, _} = AgentStates.disconnect("a.one", owner, "t9", server: ctx.name)
      refute_received {:announce, _}
    end

    test "the permission overlay never announces, hidden or visible" do
      ctx = start()

      put(ctx, hidden_env("a.hidden"))
      put(ctx, visible_env("a.visible"))
      assert_received {:announce, "a.visible"}
      drain()

      for id <- ["a.hidden", "a.visible"] do
        assert :ok =
                 AgentStates.overlay_permission_control(id, %{"request" => 1}, server: ctx.name)
      end

      refute_received {:announce, _}
    end

    test "history-only writers announce nothing and do not evaluate the predicate" do
      ctx = start()

      put(ctx, visible_env("a.one"))
      drain()

      assert :ok = AgentStates.append_log(env("a.one", "log"), server: ctx.name)
      assert :ok = AgentStates.append_log(env("a.one", "log"), server: ctx.name)

      refute_received {:announce, _}
      refute_received {:visible?, _}
    end

    test "delete announces nothing" do
      ctx = start()
      owner = self()

      put(ctx, visible_env("a.one"), owner)
      assert {:ok, _} = AgentStates.disconnect("a.one", owner, "t9", server: ctx.name)
      drain()

      assert :ok = AgentStates.delete("a.one", server: ctx.name)
      refute_received {:announce, _}
      refute_received {:visible?, _}
    end
  end

  describe "a callback that fails" do
    # Each case checks the reply, the stored entry, and that it is still the
    # same live process: a raise inside AgentStates would empty every
    # dashboard.
    defp assert_unharmed(ctx, envelope) do
      assert :ok = put(ctx, envelope)
      assert envelope == AgentStates.get_envelope(envelope["agent_id"], server: ctx.name)
      assert Process.alive?(ctx.store)
      assert Process.whereis(ctx.name) == ctx.store
    end

    for {how, failing} <- [
          raise: quote(do: fn _ -> raise "callback failed" end),
          throw: quote(do: fn _ -> throw(:callback_failed) end),
          exit: quote(do: fn _ -> exit(:callback_failed) end)
        ] do
      test "on_viewer_visible that #{how}s on a hidden to visible put" do
        ctx = start(on_viewer_visible: unquote(failing))

        put(ctx, hidden_env("a.one"))

        capture_log(fn -> assert_unharmed(ctx, visible_env("a.one")) end)
      end

      test "visible? that #{how}s on the new envelope announces nothing" do
        parent = self()

        ctx =
          start(
            visible?: fn _ -> unquote(failing).(:x) end,
            on_viewer_visible: fn id -> send(parent, {:announce, id}) end
          )

        capture_log(fn -> assert_unharmed(ctx, visible_env("a.one")) end)
        refute_received {:announce, _}
      end
    end

    test "on_viewer_visible that throws on a hidden to visible disconnect" do
      ctx = start(on_viewer_visible: fn _ -> throw(:callback_failed) end)
      owner = self()
      put(ctx, hidden_env("a.one"), owner)

      capture_log(fn ->
        assert {:ok, %{"state" => "disconnected"} = derived} =
                 AgentStates.disconnect("a.one", owner, "t9", server: ctx.name)

        assert derived == AgentStates.get_envelope("a.one", server: ctx.name)
      end)

      assert Process.alive?(ctx.store)
    end

    # The old envelope's evaluation failing must read as "no transition", not as
    # "was hidden": otherwise a broken predicate would announce by mistake.
    test "visible? that fails only on the old envelope announces nothing" do
      parent = self()

      visible? = fn
        %{"type" => "instruction_rejected"} -> raise "old envelope"
        %{"type" => "state_change"} -> true
      end

      ctx =
        start(visible?: visible?, on_viewer_visible: fn id -> send(parent, {:announce, id}) end)

      put(ctx, hidden_env("a.one"))
      capture_log(fn -> assert_unharmed(ctx, visible_env("a.one")) end)
      refute_received {:announce, _}
    end

    test "the log names the agent and the callback, never the envelope" do
      secret = "OPERATOR-ONLY-CONTENT"

      # A function clause error prints its arguments in its message.
      ctx = start(visible?: fn %{"type" => "never"} -> true end)

      log =
        capture_log(fn -> put(ctx, visible_env("a.one", %{"payload" => %{"text" => secret}})) end)

      assert log =~ "a.one"
      assert log =~ "visible?"
      assert log =~ "FunctionClauseError"
      refute log =~ secret
    end
  end

  test "an AgentStates started without callbacks stores envelopes and announces nothing" do
    name = :"agent_states_plain_#{System.unique_integer([:positive])}"
    store = start_supervised!({AgentStates, name: name})

    assert :ok = AgentStates.put(visible_env("a.one"), server: name)
    assert :ok = AgentStates.put(hidden_env("a.one"), server: name)
    assert Process.alive?(store)
  end

  describe "the production predicate" do
    test "an agent with no entry is not visible" do
      refute StatusLineVisibility.viewer_visible?(nil)
    end

    test "the envelope types a viewer receives, rewritten or not, are visible" do
      for type <- ["state_change", "permission_request", "question_request", "session_boundary"] do
        assert StatusLineVisibility.viewer_visible?(env("a.one", type)),
               "#{type} should be visible"
      end
    end

    test "types the viewer projection drops are not visible" do
      for type <- [
            "log",
            "inter_agent_message",
            "instruction_rejected",
            "attach_rejected",
            "task"
          ] do
        refute StatusLineVisibility.viewer_visible?(env("a.one", type)),
               "#{type} should be hidden"
      end

      refute StatusLineVisibility.viewer_visible?(%{"agent_id" => "a.one"})
    end

    test "agrees with the real projection through AgentStates" do
      parent = self()

      ctx =
        start(
          visible?: &StatusLineVisibility.viewer_visible?/1,
          on_viewer_visible: fn id -> send(parent, {:announce, id}) end
        )

      put(ctx, hidden_env("a.one"))
      refute_received {:announce, _}
      put(ctx, visible_env("a.one"))
      assert_received {:announce, "a.one"}
    end
  end
end
