defmodule KaoiroServer.AgentAcceptance do
  @moduledoc """
  Per-agent_id serialization point for the two operator-driven
  "acceptance" commits that must never both succeed for the same agent
  at once (issue #305 M7, ふじ round 1 / director ruling 2026-09-06): a
  `session_reset` acquiring `SessionResets`'s lock, and a
  `set_permission` persisting through `PermissionSettings.submit_request/6`.

  `agents_channel.ex`'s existing early guards (`guard_against_reset_pending/2`
  before `set_permission`, `SessionResets.check_and_acquire/4`'s own
  KaoiroState/cooldown/lock checks before a reset) stay in place for fast,
  UX-facing rejection — they are cheap and catch the common case. But each
  guard runs on ITS OWN channel process, so a genuine race remains: a
  `set_permission` that passed its early re-check and a `session_reset`
  that acquires its lock on a DIFFERENT process can both reach their own
  commit point before either one's result is visible to the other,
  demonstrated by ふじ's real test (suspending `PermissionSettings` for
  2.1s after the channel-level guard, then completing a `session_reset` on
  a separate channel, then resuming — both commands succeeded). `run/2`
  closes this by making the ACTUAL commit — not just the early guard — go
  through one shared choke point PER AGENT: `set_permission` re-checks
  `SessionResets.guard_instruction/1` and calls `submit_request/6` inside
  it; `session_reset` calls `SessionResets.check_and_acquire/4` inside it.
  Whichever commit's `run/2` call is processed first by that agent's
  worker fully completes (guard + persist) before the other one's
  function even starts, so the two can never straddle each other's
  commit FOR THAT AGENT.

  Deliberately does NOT know about `PermissionSettings` or `SessionResets`
  — callers pass their own closure, keeping this module a pure exclusion
  point rather than a hub that has to learn every future acceptance kind.

  Serializes PER agent_id (director round-2 correction, 2026-09-06 —
  withdraws an earlier "serialize globally" design this module shipped
  with first): one ephemeral worker GenServer per agent_id, registered
  via `Registry` and started on demand under a `DynamicSupervisor`, so a
  slow/stuck closure for agent A (e.g. `Users.get_or_create/4` waiting
  out its own bounded timeout) never delays agent B's `session_reset` —
  they run on entirely separate processes. `run/2` looks the worker up
  (or starts it) on every call rather than caching a pid, so a crashed
  worker is transparently replaced by the next call. `delete/1` (called
  from `agents_channel.ex`'s `delete_agent` purge path, alongside
  `AgentStates.delete/1`/`PermissionSettings.delete/2`) terminates the
  worker on agent deletion — a code-review-assessment finding, issue
  #305 round 1: without this, ordinary agent churn (not just an attack)
  grows the worker/Registry-entry count without bound over a
  long-running server's lifetime, since `DynamicSupervisor` sets no
  `max_children` and nothing else ever reclaimed one.

  `fun.()` runs inside a `try/catch` (code-review-assessment finding,
  issue #305 round 1): before this guard, an inner `GenServer.call`
  (e.g. `PermissionSettings.submit_request/6` under real DETS/disk
  contention) that exceeded ITS OWN default timeout would raise an
  uncaught `exit` INSIDE this module's `handle_call`, crashing the
  worker for that one agent — every OTHER agent is on a different
  process and is unaffected either way, but a crash still loses the
  in-flight reply for THIS caller. A caught exit degrades to
  `{:error, :acceptance_unavailable}` for that ONE `run/2` call instead.

  `run/2`'s own OUTER call uses a bounded timeout longer than every
  inner closure's own worst case (director round-2 correction: `:infinity`
  was rejected — an unbounded wait would freeze the calling channel
  process, and therefore the operator's whole dashboard socket,
  indefinitely if a worker ever truly wedges) rather than `:infinity`.
  A timeout here is caught and ALSO degrades to
  `{:error, :acceptance_unavailable}`, so `run/2` never raises to its
  caller either way.
  """

  use GenServer

  require Logger

  @registry __MODULE__.Registry
  @supervisor __MODULE__.Supervisor

  # Longer than every inner closure's own worst-case bounded wait
  # (`Users.get_or_create/4`, `PermissionSettings.submit_request/6`,
  # `SessionResets.*` are all default-5000ms `GenServer.call`s) so a
  # slow-but-answering inner call has room to finish and have `safe_run/1`
  # reply gracefully before this OUTER call's own timeout would otherwise
  # fire first and mask that graceful reply with a raw `exit`.
  @run_timeout_ms 15_000
  @registry_removal_attempts 100

  @doc false
  def start_link(agent_id) when is_binary(agent_id) do
    GenServer.start_link(__MODULE__, :ok, name: via(agent_id))
  end

  defp via(agent_id), do: {:via, Registry, {@registry, agent_id}}

  @doc """
  Runs `fun` (a 0-arity function) to completion on `agent_id`'s own
  worker before any OTHER `run/2` call FOR THAT SAME agent_id begins —
  a call for a DIFFERENT agent_id runs concurrently on its own worker
  (see moduledoc). Returns whatever `fun` returns, or
  `{:error, :acceptance_unavailable}` if `fun` raised an `exit`, or if
  this call's own outer wait exceeded `#{@run_timeout_ms}`ms. `fun`
  should be the smallest closure that covers the actual commit
  (re-check + persist), not surrounding broadcast/audit side effects
  that do not need to be inside the lock.
  """
  def run(agent_id, fun) when is_binary(agent_id) and is_function(fun, 0) do
    pid = ensure_worker(agent_id)
    GenServer.call(pid, {:run, fun}, @run_timeout_ms)
  catch
    :exit, reason ->
      Logger.warning(
        "AgentAcceptance: run/2 did not complete for agent_id=#{agent_id} " <>
          "(#{inspect(reason)})"
      )

      {:error, :acceptance_unavailable}
  end

  defp ensure_worker(agent_id) do
    case Registry.lookup(@registry, agent_id) do
      [{pid, _value}] ->
        pid

      [] ->
        case DynamicSupervisor.start_child(@supervisor, %{
               id: __MODULE__,
               start: {__MODULE__, :start_link, [agent_id]},
               restart: :transient
             }) do
          {:ok, pid} -> pid
          {:error, {:already_started, pid}} -> pid
        end
    end
  end

  @doc """
  Terminates `agent_id`'s worker, if one exists — idempotent, `:ok`
  either way. Call this on agent deletion (see moduledoc) so a
  long-running server's worker/Registry-entry count tracks the
  concurrently-live agent set instead of every distinct agent_id it has
  EVER seen. A respawn under the same agent_id afterward simply starts a
  fresh worker on its next `run/2` call, with no state to carry over
  (workers hold no state of their own — `handle_call({:run, fun}, ...)`
  is stateless).
  """
  def delete(agent_id) when is_binary(agent_id) do
    case Registry.lookup(@registry, agent_id) do
      [{pid, _value}] ->
        ref = Process.monitor(pid)
        _ = DynamicSupervisor.terminate_child(@supervisor, pid)
        await_worker_removal(agent_id, pid, ref)

      [] ->
        :ok
    end

    :ok
  end

  defp await_worker_removal(agent_id, pid, ref) do
    receive do
      {:DOWN, ^ref, :process, ^pid, _reason} -> :ok
    end

    await_registry_removal(agent_id)
  end

  defp await_registry_removal(agent_id, attempts \\ @registry_removal_attempts)

  defp await_registry_removal(agent_id, 0) do
    Logger.warning(
      "AgentAcceptance: Registry entry did not clear after worker termination " <>
        "for agent_id=#{agent_id}"
    )

    :ok
  end

  defp await_registry_removal(agent_id, attempts) do
    case Registry.lookup(@registry, agent_id) do
      [] ->
        :ok

      _still_registered ->
        Process.sleep(1)
        await_registry_removal(agent_id, attempts - 1)
    end
  end

  @impl true
  def init(:ok), do: {:ok, nil}

  @impl true
  def handle_call({:run, fun}, _from, state) do
    {:reply, safe_run(fun), state}
  end

  defp safe_run(fun) do
    fun.()
  catch
    :exit, reason ->
      Logger.warning("AgentAcceptance: closure raised an exit (#{inspect(reason)})")
      {:error, :acceptance_unavailable}
  end
end
