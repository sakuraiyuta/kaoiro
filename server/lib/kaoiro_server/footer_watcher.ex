defmodule KaoiroServer.FooterWatcher do
  @moduledoc """
  Watches `KAOIRO_FOOTER_DIR` and rebuilds `FooterAssets` on footer file
  changes (ADR-0045 F4).

  Deliberately separate from `PersonaWatcher`: the roots differ (the
  footer root is a `:ro` mount, the persona root takes pack drops) and
  the match is by exact file name — `system-footer.md` and
  `user-footer.md` directly under the root, never an arbitrary `*.md`.

  The watcher opts out of the supervision tree entirely (`:ignore`) when
  `KAOIRO_FOOTER_DIR` is unset or the directory is absent. The server
  does not create it — a `:ro` mount cannot be created from inside — so
  enabling the watcher after the fact takes a restart.

  Like `PersonaWatcher`, bursts collapse into one rebuild via a short
  debounce; a rewrite of both files inside one window may briefly mix old
  and new (ADR-0045 F4 accepts this — the next rebuild converges).
  """

  use GenServer

  require Logger

  alias KaoiroServer.FooterAssets

  @debounce_ms 300

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(opts) do
    dir = Keyword.get(opts, :dir) || FooterAssets.footer_dir()

    cond do
      is_nil(dir) ->
        :ignore

      not File.dir?(dir) ->
        # Warned about once by `FooterAssets.init/1`; here we only refuse
        # to watch. Never mkdir — the root is expected to be `:ro`.
        :ignore

      true ->
        start_watching(dir)
    end
  end

  defp start_watching(dir) do
    case FileSystem.start_link(dirs: [dir]) do
      {:ok, pid} ->
        FileSystem.subscribe(pid)
        {:ok, %{watcher: pid, dir: Path.expand(dir), pending: nil}}

      other ->
        Logger.warning(
          "FooterWatcher: file_system did not start (#{inspect(other)}); " <>
            "live footer updates disabled, rebuild only on restart"
        )

        :ignore
    end
  end

  @doc """
  Whether a filesystem event path is one of the two watched footer files
  directly under `root` (ADR-0045 F4). Exposed for tests: on hosts
  without an inotify backend the watcher never starts, so the matcher is
  otherwise unreachable.
  """
  def watched_event?(path, root) do
    expanded = Path.expand(path)

    Path.dirname(expanded) == Path.expand(root) and
      Path.basename(expanded) in FooterAssets.watched_files()
  end

  @impl true
  def handle_info({:file_event, pid, {path, _events}}, %{watcher: pid} = state) do
    if watched_event?(path, state.dir) do
      {:noreply, schedule_rebuild(state)}
    else
      {:noreply, state}
    end
  end

  # Backend died: rebuild once so a shutdown burst is not lost, then exit
  # and let the supervisor restart us.
  def handle_info({:file_event, pid, :stop}, %{watcher: pid} = state) do
    FooterAssets.rebuild()
    {:stop, :normal, state}
  end

  def handle_info(:rebuild, state) do
    FooterAssets.rebuild()
    {:noreply, %{state | pending: nil}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  defp schedule_rebuild(state) do
    if is_reference(state.pending) do
      Process.cancel_timer(state.pending)
    end

    ref = Process.send_after(self(), :rebuild, @debounce_ms)
    %{state | pending: ref}
  end
end
