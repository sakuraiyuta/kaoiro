defmodule KaoiroServer.ClearWatermarks do
  @moduledoc """
  Restart-surviving per-agent clear watermark (issue #109). When operator
  `clear_history(agent_id)` succeeds, the current UTC timestamp is stored
  here; on subsequent history-merge paths, `inter_agent_message` envelopes
  whose `ts` is <= this watermark are hidden from `agent_id`'s transcript
  pane. Peer agents' panes are unaffected (their own watermark controls
  what they see), and the shared `InterAgentHistory` DETS ledger itself is
  untouched — a compromised or restarted server still surfaces the
  authoritative sender copy to any peer whose watermark permits it.

  Mirrors the `PermissionModes` / `SessionPointers` store: tiny payload,
  DETS-backed, in-memory mirror for fast reads, fire-and-forget writes
  from the operator handler path. `agent_id => watermark_iso8601` where
  the watermark is an ISO-8601 UTC timestamp, chosen to match the
  envelope's own `ts` field (per `docs/specs/protocol.md`) so a straight
  string compare gives lexicographic time-order between them.
  """

  use GenServer

  require Logger

  @doc """
  Starts the store. `:path` overrides the DETS file and `:name` the
  registered name + DETS table (tests run isolated instances).
  """
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path, default_path())
    GenServer.start_link(__MODULE__, {name, path}, name: name)
  end

  @doc """
  Records `ts` as the agent's clear watermark. Fire-and-forget — the
  operator's `clear_history` reply does not wait on DETS sync.
  """
  def record(agent_id, ts, server \\ __MODULE__) when is_binary(ts) do
    GenServer.cast(server, {:record, agent_id, ts})
  end

  @doc "Latest watermark for the agent, or nil."
  def get(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:get, agent_id})
  end

  @doc "agent_id => watermark_iso8601 for every known clear."
  def all(server \\ __MODULE__) do
    GenServer.call(server, :all)
  end

  @doc """
  Removes the agent's watermark from memory + DETS. Idempotent — unknown
  agent returns `:ok`. Synchronous so the operator-driven `delete_agent`
  path in `agents_channel.ex` can wait for the purge before broadcasting
  `agent_deleted` (ADR-0030 D6, privacy: no lingering watermark trace
  after the agent identity is gone).
  """
  def delete(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:delete, agent_id})
  end

  @impl true
  def init({name, path}) do
    path |> Path.dirname() |> File.mkdir_p!()
    table = open_table(name, path)
    # Watermarks are not personally sensitive on their own, but the file
    # sits alongside the other agent DETS stores; keep the chmod symmetric
    # so a shared /tmp cannot become the weak link.
    _ = File.chmod(path, 0o600)
    {:ok, %{table: table, watermarks: load_watermarks(table)}}
  end

  # A corrupt / unreadable DETS file must not crash-loop the supervisor.
  # Losing watermarks re-exposes at most the pre-clear IA a single time;
  # the operator can re-clear if it matters. Same fallback pattern as
  # PermissionModes / SessionPointers.
  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, reason} ->
        Logger.warning("clear watermark store unreadable (#{inspect(reason)}); recreating")

        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  defp load_watermarks(table) do
    case :dets.foldl(
           fn {agent_id, ts}, acc -> Map.put(acc, agent_id, ts) end,
           %{},
           table
         ) do
      watermarks when is_map(watermarks) -> watermarks
      {:error, _reason} -> %{}
    end
  end

  @impl true
  def handle_cast({:record, agent_id, ts}, state) do
    # A repeat clear at the same instant is a no-op (idempotent), but a
    # later ts always wins — the operator asked to hide more, not less.
    # Never move the watermark BACKWARDS: an out-of-order retry of an
    # older clear must not re-expose IA the newer clear just hid.
    current = Map.get(state.watermarks, agent_id)

    if is_binary(current) and current >= ts do
      {:noreply, state}
    else
      :ok = :dets.insert(state.table, {agent_id, ts})
      {:noreply, %{state | watermarks: Map.put(state.watermarks, agent_id, ts)}}
    end
  end

  @impl true
  def handle_call({:get, agent_id}, _from, state) do
    {:reply, Map.get(state.watermarks, agent_id), state}
  end

  def handle_call(:all, _from, state) do
    {:reply, state.watermarks, state}
  end

  def handle_call({:delete, agent_id}, _from, state) do
    :ok = :dets.delete(state.table, agent_id)
    {:reply, :ok, %{state | watermarks: Map.delete(state.watermarks, agent_id)}}
  end

  @impl true
  def terminate(_reason, state) do
    :dets.close(state.table)
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :clear_watermarks_path) ||
      Path.join(System.tmp_dir!(), "kaoiro_clear_watermarks.dets")
  end
end
