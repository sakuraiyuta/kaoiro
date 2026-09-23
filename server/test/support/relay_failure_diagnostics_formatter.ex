defmodule KaoiroServer.Test.RelayFailureDiagnosticsFormatter do
  @moduledoc """
  CI-only diagnostics for ExUnit missing-message timeouts.

  Limits: the formatter receives the failure after the test process and its
  linked channel have exited, so the channel's current function is unavailable.
  This only observes singleton processes and VM-wide signals.
  """

  use GenServer

  @process_names [
    KaoiroServer.AgentStates,
    KaoiroServer.PlannedDisconnects,
    KaoiroServer.ConversationStates,
    KaoiroServer.HostRegistry,
    KaoiroServer.AgentDirectory,
    KaoiroServer.SessionPointers,
    KaoiroServer.PermissionModes,
    KaoiroServer.PermissionSettings,
    KaoiroServer.SessionResets,
    KaoiroServer.TokenDenylist,
    KaoiroServer.AgentActivity,
    KaoiroServer.AgentAcceptance.Registry,
    KaoiroServer.AgentAcceptance.Supervisor,
    KaoiroServer.ClearWatermarks,
    KaoiroServer.SessionStarts,
    KaoiroServer.DeliveryStates
  ]

  @process_info_keys [
    :message_queue_len,
    :current_function,
    :status,
    :reductions,
    :heap_size,
    :total_heap_size,
    :memory,
    :garbage_collection
  ]

  @impl true
  def init(_opts), do: {:ok, nil}

  @impl true
  def handle_cast(
        {:test_finished, %ExUnit.Test{state: {:failed, failures}} = test},
        state
      ) do
    try do
      if target_failure?(failures), do: emit_diagnostics(test)
    rescue
      _ -> :ok
    catch
      _, _ -> :ok
    end

    {:noreply, state}
  end

  def handle_cast(_event, state), do: {:noreply, state}

  @doc false
  def process_snapshot(name) when is_atom(name) do
    try do
      case Process.whereis(name) do
        nil ->
          %{probe: :unavailable}

        pid ->
          case Process.info(pid, @process_info_keys) do
            nil -> %{probe: :exited, pid: inspect(pid)}
            info -> %{probe: :available, pid: inspect(pid), process: Map.new(info)}
          end
      end
    rescue
      _ -> %{probe: :unavailable}
    catch
      _, _ -> %{probe: :unavailable}
    end
  end

  defp target_failure?(failures) do
    Enum.any?(failures, fn
      {_kind, reason, _stacktrace} when is_exception(reason) ->
        String.contains?(Exception.message(reason), "no matching message after")

      _ ->
        false
    end)
  end

  defp emit_diagnostics(test) do
    diagnostic = %{
      test: %{name: test.name, line: test.tags[:line], time_us: test.time},
      sampled_at: %{
        wall_time_ms: System.system_time(:millisecond),
        monotonic_time_us: System.monotonic_time(:microsecond)
      },
      processes: Map.new(@process_names, &{&1, process_snapshot(&1)}),
      logger_std_h_default: process_snapshot(:logger_std_h_default),
      run_queue_lengths: safe_sample(fn -> :erlang.statistics(:run_queue_lengths) end),
      total_memory: safe_sample(fn -> :erlang.memory(:total) end)
    }

    IO.binwrite(:stderr, [
      "\n=== relay assertion diagnostics ===\n",
      inspect(diagnostic, pretty: true, limit: :infinity, printable_limit: :infinity),
      "\n=== end relay assertion diagnostics ===\n"
    ])
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end

  defp safe_sample(fun) do
    try do
      fun.()
    rescue
      _ -> :unavailable
    catch
      _, _ -> :unavailable
    end
  end
end
