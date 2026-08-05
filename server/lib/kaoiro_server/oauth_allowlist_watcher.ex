defmodule KaoiroServer.OAuthAllowlistWatcher do
  @moduledoc """
  Change-driven targeted disconnect for OAuth allow-list edits (issue
  #170, ふじ 2026-08-05 spec).

  `AgentsChannel.current_role/1` (issue #158) already re-resolves role
  live on every OPERATOR-INITIATED action, so a socket that keeps
  talking is caught the moment it acts on a role it no longer has. What
  #158 left open is a socket that never sends anything after its
  allow-list entry changes: `handle_out`'s fan-out reads
  `socket.assigns[:role]`, the connect-time snapshot, for as long as
  nothing forces a reconnect. This module closes that gap by targeting
  exactly the identities whose allow-list entry changed, reusing the
  SAME per-socket disconnect broadcast #47/#158 already send
  (`Endpoint.broadcast(socket_id, "disconnect", %{})`), addressed via
  `Auth.oauth_socket_id/2` computed straight from the allow-list's own
  (already-normalized) keys. No live-socket registry or enumeration is
  needed anywhere — measured: none exists in this codebase (no
  `Phoenix.Presence` dependency, no `Registry` tracking client
  credentials; see `docs/specs/auth-and-authz.md`).

  `AgentsChannel.join/3` closes the companion race window: a socket
  whose `connect/3` resolved a role that the allow-list changed out
  from under it BEFORE the transport finished subscribing to its
  disconnect topic would miss this module's broadcast entirely and
  still complete its join with the stale role. `join/3` re-resolves
  live and refuses the join on a mismatch (same disconnect broadcast),
  which is always safe there because by `join/3` time the transport's
  socket-id subscription has already completed.

  ## Checkpoint: `:persistent_term`, not a live-socket registry

  A `{provider, identifier} => role` snapshot (`OAuthAllowlist.
  snapshot/1`) is kept as the last-reconciled checkpoint in
  `:persistent_term`. This is NOT a new authorization store — the
  allow-list FILE stays the single source of truth for every actual
  auth decision (`role_for/2` still re-reads it live, unchanged). The
  checkpoint exists only so a watcher PROCESS restart (crash + OTP
  supervisor restart, not a full BEAM restart) does not lose track of
  what was already reconciled and silently skip a change that landed
  during the crash. `:persistent_term` survives exactly that kind of
  restart; a full BEAM restart drops it too, but every socket is gone
  at that point as well, so there is nothing left to reconcile against.

  Update order (MUST — this is what makes a crash mid-reconcile safe):

    1. diff the retained checkpoint against the current snapshot
    2. disconnect-broadcast EVERY changed key
    3. only once every broadcast in (2) returned `:ok`, advance the
       checkpoint to the current snapshot
    4. a crash/error between (2) and (3) leaves the OLD checkpoint in
       place, so the next reconcile (event-triggered or periodic)
       computes the SAME diff and resends. The broadcast itself is
       idempotent (disconnecting an already-gone or never-existed
       socket is a no-op), so a duplicate resend is safe.

  `:persistent_term.put/2` triggers a global GC (OTP docs: "updating a
  term is expensive"). The periodic reconcile runs every
  `@reconcile_interval_ms` regardless of whether anything changed, so
  step 3 is skipped entirely — no `put` at all — when the diff in step
  1 is empty. Do not "optimize" this by comparing the checkpoint and
  current maps for equality instead of tracking the diff explicitly:
  the diff *is* the equality check, and computing it twice would just
  move the cost, not remove it.

  First-ever boot is a special, simpler case of the same mechanism:
  this watcher starts (`application.ex`) after `Phoenix.PubSub` but
  BEFORE `KaoiroServerWeb.Endpoint`, so no client socket can possibly
  exist yet. The checkpoint is absent from `:persistent_term` in that
  case (`:not_set`), so the current snapshot is seeded directly without
  diffing against `%{}` — diffing there would broadcast-disconnect to
  every configured identity for no reason (harmless, since nothing is
  subscribed yet, but pointless log/broadcast noise every boot).

  ## Detection: event fast-path + periodic reconcile backstop

  A `file_system` (inotify/FSEvents) subscription on the allow-list
  file's parent directory is the FAST path — mirrors `PersonaWatcher`
  / `FooterWatcher`'s dir+basename-filter pattern. Unlike those two
  siblings, this watcher does NOT `:ignore` itself when the backend
  fails to start or the parent directory is (temporarily) missing:
  doing so would let an AUTHORIZATION control quietly stop enforcing
  revocation with nothing but a boot-time log line to notice by. A
  missing/failed event source degrades to POLL-ONLY (the periodic
  reconcile alone), never to `:ignore`. `:ignore` is reserved for the
  one case where the feature itself is off
  (`KAOIRO_OAUTH_ALLOWLIST_PATH` unset — nothing to revoke, since
  `OAuthAllowlist.snapshot/1` already always returns `%{}` for that
  case and live role resolution already fails closed on its own).

  The event path also does NOT use the trailing-edge debounce
  `PersonaWatcher`/`FooterWatcher` use (cancel + reschedule on every
  new event): under continuous churn that pattern can defer the
  reconcile indefinitely, which for an authorization control means
  revocation could be postponed for as long as edits keep arriving.
  Instead the FIRST event in a burst arms a timer and later events
  during the SAME window do not extend it, so a reconcile always runs
  within `@debounce_ms` of the first relevant event.

  The periodic reconcile is the actual guarantee: every
  `@reconcile_interval_ms`, unconditionally, independent of whether any
  filesystem event fired. This bounds an event-detection failure
  (backend never starts, an event silently drops, the parent directory
  reappears after being absent at boot) to a fixed delay instead of a
  permanent hole — the event path is a latency optimization on top of
  it, not the enforcement mechanism itself.

  ## Fail-closed on a broken allow-list (issue #170 懸念 B)

  An unreadable or partially/mid-write file resolves to whatever
  `OAuthAllowlist.snapshot/1` can parse from it (malformed lines
  skipped, unreadable = `%{}`) — the same as the live `role_for/2` path
  already does. Every key missing from that result relative to the
  checkpoint is treated as a real removal and disconnected immediately;
  there is no last-known-good fallback and no "same content twice"
  stabilization pass. Holding a broken read as authoritative would mean
  a demoted/removed operator keeps their stale role for however long
  the file stays broken — a fail-OPEN window this module exists
  specifically to close. The operational mitigation is a temp-file +
  atomic-rename edit workflow (`docs/specs/auth-and-authz.md`), which
  only LOWERS THE PROBABILITY of ever reading a half-written file — it
  is not a guarantee, and must not be read as one.

  `OAuthAllowlist.snapshot(log?: false)` suppresses that module's
  per-call warnings for the poll path — without it, an unreadable or
  malformed file would repeat the identical warning every
  `@reconcile_interval_ms` forever. `role_for/2`'s own (unsuppressed)
  warnings on actual connect/refresh attempts remain the operator-facing
  signal that something is broken.
  """

  use GenServer

  require Logger

  alias KaoiroServer.Auth
  alias KaoiroServer.OAuthAllowlist

  @checkpoint_key {__MODULE__, :checkpoint}

  # First event in a burst reconciles within this bound; later events in
  # the same window do NOT extend it (issue #170 must-fix 1 — the
  # opposite of PersonaWatcher/FooterWatcher's trailing-edge debounce,
  # which can starve for as long as edits keep arriving).
  @debounce_ms 300

  # Backstop guarantee independent of the file_system event path (issue
  # #170 must-fix 1). Seconds-scale: an authz control should not lag far
  # behind an edit, but this is a floor under the event path, not the
  # primary latency.
  @reconcile_interval_ms 5_000

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @impl true
  def init(opts) do
    path =
      Keyword.get(opts, :path) || Application.get_env(:kaoiro_server, :oauth_allowlist_path)

    case path do
      p when is_binary(p) and p != "" ->
        state =
          p
          |> start_watching()
          |> Map.merge(%{
            # OAuthAllowlist.snapshot/1 is called with THIS path, not left
            # to re-resolve :oauth_allowlist_path itself — otherwise a
            # caller-supplied `:path` opt (tests) would watch one file
            # while reconciling against whatever Application env happens
            # to hold, which need not be the same file.
            path: p,
            debounce_ms: Keyword.get(opts, :debounce_ms, @debounce_ms),
            reconcile_interval_ms:
              Keyword.get(opts, :reconcile_interval_ms, @reconcile_interval_ms),
            # Injectable only for the "broadcast failure -> checkpoint not
            # advanced" test (issue #170 必須テスト 10): Phoenix.PubSub's
            # real local broadcast has no practical way to fail in a test
            # without stopping the shared PubSub process, so the failure
            # path is exercised by injecting a stub here instead. Defaults
            # to the real broadcast in every non-test caller.
            broadcast: Keyword.get(opts, :broadcast, &KaoiroServerWeb.Endpoint.broadcast/3)
          })

        reconcile_now(state)
        {:ok, schedule_periodic(state)}

      _ ->
        :ignore
    end
  end

  defp start_watching(path) do
    dir = Path.dirname(path)

    base = %{
      dir: Path.expand(dir),
      basename: Path.basename(path),
      watcher: nil,
      event_pending: nil,
      periodic_ref: nil
    }

    if File.dir?(dir) do
      case FileSystem.start_link(dirs: [dir]) do
        {:ok, pid} ->
          FileSystem.subscribe(pid)
          %{base | watcher: pid}

        other ->
          Logger.warning(
            "OAuthAllowlistWatcher: file_system did not start (#{inspect(other)}); " <>
              "falling back to periodic polling only, revocation still bounded " <>
              "by the periodic reconcile"
          )

          base
      end
    else
      Logger.warning(
        "OAuthAllowlistWatcher: #{dir} not found; falling back to periodic " <>
          "polling only for this process's lifetime (the fast path is not " <>
          "retried even if the directory later appears — a future restart " <>
          "picks it up), revocation still bounded by the periodic reconcile"
      )

      base
    end
  end

  # `FileSystem.start_link/1` links the started worker to us, but that
  # link does not help on a CONTROLLED stop: this GenServer terminating
  # with reason `:normal` (the file_event `:stop` handler's
  # `{:stop, :normal, state}`, or an external `GenServer.stop/1`, whose
  # default reason is also `:normal`) does NOT propagate through the
  # link — OTP never treats a `:normal` exit as fatal to a linked
  # process — and `file_system`'s own worker has no owner-monitor to
  # notice we are gone on its own. Left alone this orphans one
  # `FileSystem.Worker` process per controlled stop/restart (ふじ
  # 2026-08-05, measured directly: `GenServer.stop(watcher)` followed by
  # `Process.alive?(fs_pid)` returns `true`). An ABNORMAL crash does not
  # need this — the link already takes the worker down with us in that
  # case — but running it unconditionally here is harmless: stopping an
  # already-dead pid just hits the `:noproc` exit caught below.
  @impl true
  def terminate(_reason, state) do
    stop_file_system_worker(state)
    :ok
  end

  defp stop_file_system_worker(%{watcher: watcher}) when is_pid(watcher) do
    # Unlink FIRST: `FileSystem.start_link/1` linked us to `watcher`, and
    # since we do not trap exits, stopping it with a non-:normal reason
    # (:shutdown) would otherwise send THAT exit signal right back to us
    # over the same link — killing this process mid-terminate/2 with
    # :shutdown instead of the reason it was actually asked to stop with
    # (measured directly: without the unlink, `GenServer.stop(watcher,
    # :shutdown)` here propagates back and the caller's own
    # `GenServer.stop/1` on THIS process observes an unexpected
    # `** (EXIT) shutdown` instead of completing normally).
    Process.unlink(watcher)
    GenServer.stop(watcher, :shutdown)
  catch
    :exit, _ -> :ok
  end

  defp stop_file_system_worker(_state), do: :ok

  @doc """
  Whether a filesystem event path is the watched allow-list file
  directly under `dir` (matches `FooterWatcher.watched_event?/2`'s
  shape). Exposed for tests: hosts without an inotify backend never
  start `file_system`, so the matcher is otherwise unreachable there.
  """
  def watched_event?(path, dir, basename) do
    expanded = Path.expand(path)
    Path.dirname(expanded) == Path.expand(dir) and Path.basename(expanded) == basename
  end

  @impl true
  def handle_info({:file_event, pid, {path, _events}}, %{watcher: pid} = state) do
    if watched_event?(path, state.dir, state.basename) do
      {:noreply, arm_event_reconcile(state)}
    else
      {:noreply, state}
    end
  end

  # Backend died: reconcile once so a shutdown burst is not lost, then
  # exit and let the supervisor restart us (retained checkpoint picks up
  # where this left off — see moduledoc).
  def handle_info({:file_event, pid, :stop}, %{watcher: pid} = state) do
    reconcile_now(state)
    {:stop, :normal, state}
  end

  def handle_info(:event_reconcile, state) do
    reconcile_now(state)
    {:noreply, %{state | event_pending: nil}}
  end

  def handle_info(:periodic_reconcile, state) do
    reconcile_now(state)
    {:noreply, schedule_periodic(state)}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # Bounded debounce (issue #170 must-fix 1): the FIRST relevant event in
  # a burst arms a timer; later events in the same window do not extend
  # it. Deliberately NOT PersonaWatcher/FooterWatcher's cancel+reschedule
  # pattern, which can defer a reconcile indefinitely under continuous
  # churn — for an authorization control that means revocation could be
  # postponed for as long as edits keep arriving.
  defp arm_event_reconcile(%{event_pending: nil} = state) do
    ref = Process.send_after(self(), :event_reconcile, state.debounce_ms)
    %{state | event_pending: ref}
  end

  defp arm_event_reconcile(state), do: state

  defp schedule_periodic(state) do
    ref = Process.send_after(self(), :periodic_reconcile, state.reconcile_interval_ms)
    %{state | periodic_ref: ref}
  end

  # See moduledoc "Checkpoint" + "Fail-closed" sections for the update
  # order and why an empty diff must not `put` (global GC cost).
  defp reconcile_now(state) do
    current = OAuthAllowlist.snapshot(path: state.path, log?: false)

    case :persistent_term.get(@checkpoint_key, :not_set) do
      :not_set ->
        :persistent_term.put(@checkpoint_key, current)

      checkpoint ->
        case changed_keys(checkpoint, current) do
          [] ->
            :ok

          changed ->
            case broadcast_all(changed, state.broadcast) do
              :ok ->
                :persistent_term.put(@checkpoint_key, current)

              :error ->
                Logger.warning(
                  "OAuthAllowlistWatcher: disconnect broadcast failed for " <>
                    "#{length(changed)} changed identity(ies); checkpoint " <>
                    "left unadvanced so the next reconcile retries the same diff"
                )
            end
        end
    end
  end

  # Every key present in either map whose resolved role differs (added,
  # removed, or role-changed — direction-agnostic, same as
  # `AgentsChannel.current_role/1`'s per-action re-resolution). A key
  # with the same role in both maps is not returned.
  defp changed_keys(old, new) do
    old
    |> Map.keys()
    |> MapSet.new()
    |> MapSet.union(MapSet.new(Map.keys(new)))
    |> Enum.filter(fn key -> Map.get(old, key) != Map.get(new, key) end)
  end

  defp broadcast_all(changed, broadcast_fun) do
    ok? =
      changed
      |> Enum.map(fn {provider, identifier} ->
        broadcast_fun.(Auth.oauth_socket_id(provider, identifier), "disconnect", %{})
      end)
      |> Enum.all?(&(&1 == :ok))

    if ok?, do: :ok, else: :error
  end
end
