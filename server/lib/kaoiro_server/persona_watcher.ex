defmodule KaoiroServer.PersonaWatcher do
  @moduledoc """
  Watches the persona ingest directory and rebuilds `PersonaAssets` on
  zip changes (ADR-0029 F6, phase-10).

  Subscribes to the `file_system` library (inotify / FSEvents / RDCW
  wrapper), so a new pack drop propagates without polling or restart.
  Events under the private `.cache/` subdirectory are filtered — the
  extractor writes there, and treating those writes as source changes
  would loop.

  Bursts of events (e.g. `mv *.zip` staging several packs at once)
  collapse into one rebuild via a short debounce timer.
  """

  use GenServer

  require Logger

  # Coalescing window for filesystem event bursts. Short enough to feel
  # instant; long enough to skip a rebuild-per-file on `cp *.zip`.
  @debounce_ms 300

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(opts) do
    dir = Keyword.get(opts, :dir) || KaoiroServer.PersonaAssets.ingest_dir()

    unless File.dir?(dir) do
      Logger.warning("PersonaWatcher: creating missing ingest dir #{dir}")
      File.mkdir_p!(dir)
    end

    # `FileSystem.start_link/1` returns a `GenServer.on_start`. Besides
    # `{:ok, pid}`, a boot failure surfaces as `{:error, reason}` or as
    # `:ignore` (the latter when the backend cannot start, e.g.
    # inotify-tools missing on Linux). Fail soft on any non-ok result:
    # live updates disabled, rebuild on restart only.
    case FileSystem.start_link(dirs: [dir]) do
      {:ok, pid} ->
        FileSystem.subscribe(pid)
        {:ok, %{watcher: pid, dir: Path.expand(dir), pending: nil}}

      other ->
        Logger.warning(
          "PersonaWatcher: file_system did not start (#{inspect(other)}); " <>
            "live updates disabled, rebuild only on restart"
        )

        {:ok, %{watcher: nil, dir: Path.expand(dir), pending: nil}}
    end
  end

  @impl true
  def handle_info({:file_event, pid, {path, _events}}, %{watcher: pid} = state) do
    if relevant?(path, state.dir) do
      {:noreply, schedule_rebuild(state)}
    else
      {:noreply, state}
    end
  end

  # file_system delivers a `:stop` message when its backend dies. Try to
  # rebuild one last time so a shutdown burst is not missed, then exit —
  # supervisor restarts us.
  def handle_info({:file_event, pid, :stop}, %{watcher: pid} = state) do
    KaoiroServer.PersonaAssets.rebuild()
    {:stop, :normal, state}
  end

  def handle_info(:rebuild, state) do
    KaoiroServer.PersonaAssets.rebuild()
    {:noreply, %{state | pending: nil}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # Only *.zip changes matter; `.cache/` writes are our own extraction
  # (would loop) and non-zip drops (README, .gitkeep) do not affect the
  # manifest.
  defp relevant?(path, root) do
    ext = Path.extname(path)
    within_cache = String.starts_with?(path, Path.join(root, ".cache"))
    ext == ".zip" and not within_cache
  end

  defp schedule_rebuild(state) do
    if is_reference(state.pending) do
      Process.cancel_timer(state.pending)
    end

    ref = Process.send_after(self(), :rebuild, @debounce_ms)
    %{state | pending: ref}
  end
end
