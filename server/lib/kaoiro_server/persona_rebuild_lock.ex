defmodule KaoiroServer.PersonaRebuildLock do
  @moduledoc """
  Serializes `KaoiroServer.PersonaAssets` rebuilds within this BEAM node
  (issue #195 must-fix 1) and owns the boot-time warm rebuild (ADR-0029).

  The rebuild operation has 3 triggers in production — boot (via this
  module's own `init/1`, started with `warm: true`),
  `PersonaWatcher`'s filesystem-event handler, and `PersonaAssets`'s own
  cache-miss fallback — with no coordination between them otherwise.
  Two racing rebuilds independently stage archives and reclaim
  `.stage-*` orphans under the same cache root, which is unsafe once
  orphan reclaim can no longer distinguish "abandoned by a crash" from
  "in use by the other racing rebuild" (see `PersonaAssets`'s
  `reclaim_stage_orphans/1`).

  NOT a generic mutex. This deliberately exposes only `rebuild/0` — no
  `exclusively(fun)`-shaped escape hatch — mirroring
  `KaoiroServer.SessionResets` / `KaoiroServer.IngressOrder`, which each
  own one specific operation inside their `handle_call/3` rather than
  accepting an arbitrary callback. A generic mutex here would invite a
  future caller to serialize unrelated work through this same process,
  which is not a risk this module is scoped to carry.

  ## Boot ownership (issue #195 round-3, ふじ 2026-08-05 spec)

  Started with `warm: true` in `KaoiroServer.Application`'s children
  list. `init/1` runs `PersonaAssets.do_rebuild/0` synchronously BEFORE
  this process (or any later child, including the Endpoint) becomes
  available — so boot goes through the SAME serialization path as every
  other rebuild, with no boot-only bypass.

  A cold-start failure there raises inside `init/1`. Measured (OTP
  29.0.2, 2026-08-05): when a ROOT supervisor's INITIAL child `init/1`
  raises, `Supervisor.start_link/2` fails immediately —
  `{:error, {:shutdown, {:failed_to_start_child, ...}}}` — because the
  supervisor has not finished its own `start_link` yet and so never
  enters the restart-intensity retry loop; `init/1` runs exactly once.
  `KaoiroServer.Application.start/2` returns whatever
  `Supervisor.start_link(children, opts)` returns, so this failure
  propagates as that function's `{:error, _}` return — an earlier design
  here had `Application.start/2` call `do_rebuild/0` directly so a
  cold-start failure would `raise` straight out of `Application.start/2`
  instead; ADR-0046 F4 requires cold start to fail fast, not that the
  failure surface as a bare `RuntimeError` at that specific call site, so
  this is still within contract. The runtime path's contract — a
  caller of `PersonaAssets.rebuild/0` sees the ORIGINAL exception
  re-raised in its own process — is unchanged; see "Exception
  passthrough" below.

  ## Exception passthrough

  `do_rebuild/0` raises on a cold-start failure (ADR-0046 F4) — a
  documented, tested part of `PersonaAssets.rebuild/0`'s contract. Left
  uncaught, that raise would crash THIS GenServer instead of the
  caller: `GenServer.call/3` turns a callback exception into a
  different exception (an `exit`) in the calling process, not the
  original one, and the crash would restart this named process out
  from under whichever other caller (e.g. `PersonaWatcher`) reaches it
  next. `handle_call/3` below catches it, and `rebuild/1` re-raises the
  SAME exception (with its original stacktrace) in the caller's own
  process — indistinguishable from calling `do_rebuild/0` directly, and
  this process stays alive.

  The reply is type-tagged (`{:ok, result}` / `{:raised, exception,
  stacktrace}`), not `result` vs. a single reserved tuple shape:
  `do_rebuild/0` is documented to always return `:ok`, but tagging the
  NORMAL branch too means a future change to its return value can never
  collide with the exception tag (ふじ round-3 spec, 2026-08-05).
  """

  use GenServer

  @doc """
  Starts the lock. `:name` overrides the registered name (tests run
  isolated instances). `:warm` (default `false`) runs the boot rebuild
  synchronously inside `init/1` — see moduledoc "Boot ownership".
  """
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    warm? = Keyword.get(opts, :warm, false)
    GenServer.start_link(__MODULE__, %{warm: warm?}, name: name)
  end

  @doc "Runs a full persona rebuild, excluding any other concurrent call."
  def rebuild(server \\ __MODULE__) do
    case GenServer.call(server, :rebuild, :infinity) do
      {:ok, result} -> result
      {:raised, exception, stacktrace} -> reraise(exception, stacktrace)
    end
  end

  @impl true
  def init(%{warm: true}) do
    :ok = KaoiroServer.PersonaAssets.do_rebuild()
    {:ok, nil}
  end

  def init(%{warm: false}), do: {:ok, nil}

  @impl true
  def handle_call(:rebuild, _from, state) do
    {:reply, {:ok, KaoiroServer.PersonaAssets.do_rebuild()}, state}
  rescue
    e -> {:reply, {:raised, e, __STACKTRACE__}, state}
  end
end
