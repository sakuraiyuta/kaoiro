defmodule KaoiroServer.AgentDirectory do
  @moduledoc """
  Restart-surviving identity ledger — `agent_id => %{persona, last_seen,
  revision}` (ADR-0030). Persists the persona map so operator-driven
  restore (`agents_channel.ex agent_persona/1`) still works after a
  server restart when `AgentStates` is empty. Mirrors the
  `SessionPointers` / `PermissionModes` shape: tiny payload, DETS-backed,
  in-memory mirror for fast reads, fire-and-forget writes (spawn path
  only — `rename/3` below is synchronous, see its own doc).

  `persona` and `revision` are both written to disk (`last_seen` stays
  memory-only, see below). `revision` is a monotonic per-agent_id counter
  bumped ONLY by `rename/3` (issue #197 段階3, D12/D15): it lets a
  wrapper that receives two rename relays out of order (broadcast
  delivery has no ordering guarantee across two different `AgentsChannel`
  processes) drop the stale one instead of rolling back to an older
  name. `record/3` is deliberately create-only (ふじ MF-2 レビュー指摘,
  see its own doc) so it can never contend with `rename/3` for revision
  authority — `rename/3` is the sole mutation path for an entry that
  already exists. The counter is NOT a general-purpose optimistic-lock
  token — nothing else in this module reads or compares it.

  `last_seen` is a memory-only unix seconds hint the client uses to
  grade "recently online" vs "long offline" — losing it on restart is
  fine (all reloaded entries look offline until the wrapper reconnects
  and touches them). Persisting every envelope's timestamp would put the
  ingest path on the disk write budget for no additional recovery value.
  """

  use GenServer

  require Logger

  # Wire-domain upper bound for `revision` — the same JS
  # `Number.MAX_SAFE_INTEGER` boundary `transport.ts`'s `persona_sync`
  # narrow enforces (2^53 - 1). `rename/3` must never emit a revision
  # past this: doing so would produce a value every wrapper's narrow
  # drops on receipt, leaving that agent's persona permanently unable to
  # converge (issue #197 段階3, ふじ MF-5 レビュー指摘).
  @max_safe_revision 9_007_199_254_740_991

  @doc """
  Starts the ledger. `:path` overrides the DETS file and `:name` the
  registered name + DETS table (tests run isolated instances).
  """
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path, default_path())
    GenServer.start_link(__MODULE__, {name, path}, name: name)
  end

  @doc """
  Records `persona` (a map with at least `"id"`, `"name"`, `"sprite_set"`)
  as a NEW agent's identity, at revision 0. Fire-and-forget so persistence
  never slows the spawn broadcast path.

  Create-only (issue #197 段階3, ふじ MF-2 レビュー指摘): an `agent_id`
  that already has an entry is left untouched, unconditionally — this
  cast never overwrites an existing entry's `persona` or `revision`,
  even when the incoming `persona` differs from what is stored. Before
  this fix, a duplicate/delayed `record/3` for an existing id (e.g. a
  retried or racing spawn cast) bumped `revision` and overwrote
  `persona`; since `rename/3` ALSO bumps `revision`, a stray delayed
  `record/3` landing after a `rename/3` could carry a HIGHER revision
  than the rename while reverting to the pre-rename name — a wrapper
  applying `persona_sync` afterward would accept it as "newer" and roll
  the display name back, exactly the outcome D15's revision guard exists
  to prevent. In normal operation this defensive branch was never
  expected to fire anyway: `agent_id` is newly allocated per spawn
  (ADR-0024 D3) and `record/3` is called exactly once per spawn, so a
  second call for the same id already implied something unusual — making
  it a safe no-op removes the failure mode entirely rather than trying to
  out-guess it.
  """
  def record(agent_id, persona, server \\ __MODULE__) when is_map(persona) do
    GenServer.cast(server, {:record, agent_id, persona})
  end

  @doc """
  Marks the agent as seen right now in the memory-only `last_seen` hint.
  No disk write — the timestamp is a hint for the client's live/offline
  merge, not persisted state (ADR-0030 A5).
  """
  def touch(agent_id, server \\ __MODULE__) do
    GenServer.cast(server, {:touch, agent_id, System.system_time(:second)})
  end

  @doc """
  Latest entry `%{persona, last_seen, revision}` for the agent, or nil.
  `last_seen` is nil until the wrapper's first envelope after the
  current process start (fresh load / restart).
  """
  def get(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:get, agent_id})
  end

  @doc "agent_id => %{persona, last_seen, revision} for every known entry."
  def all(server \\ __MODULE__) do
    GenServer.call(server, :all)
  end

  @doc """
  Renames the agent's persona display name (issue #197 段階3, D12).
  `name` must already be trimmed/validated by the caller
  (`agents_channel.ex`'s rename validation, same 64-grapheme /
  control-char rule `apply_custom_name/2` uses at spawn) — this function
  only rejects an unknown `agent_id`, it does not re-validate `name`'s
  shape (same division of labor `record/3` already has with its
  caller-built `persona` map).

  Synchronous (`GenServer.call`, unlike the fire-and-forget `record/3`)
  for two reasons: the caller needs the bumped `revision` back before it
  can relay the rename to the wrapper (D15 — the revision is what lets a
  wrapper drop an out-of-order relay), and two concurrent renames of the
  same agent must serialize through this single GenServer's mailbox
  rather than racing each other's disk writes.

  Returns `{:ok, %{persona:, last_seen:, revision:}}` (the updated
  entry), `{:error, :not_found}` for an agent_id this ledger has never
  recorded (never spawned, or already deleted), or `{:error,
  :revision_exhausted}` when the entry's current revision already sits
  at `@max_safe_revision` (issue #197 段階3, ふじ MF-5 レビュー指摘):
  bumping it further would emit a `revision` outside the wire's
  safe-integer domain, which every wrapper's `persona_sync` narrow drops
  on receipt — permanently stranding that agent's persona. Fail-closed:
  the entry is left completely untouched (no DETS write, no broadcast,
  no relay) rather than silently succeeding at the same revision, which
  would just reproduce the MF-2/MF-3 divergence under a new trigger.
  """
  def rename(agent_id, name, server \\ __MODULE__) when is_binary(name) do
    GenServer.call(server, {:rename, agent_id, name})
  end

  @doc """
  Removes the agent's entry from memory + DETS. Idempotent — an unknown
  agent returns `:ok`. Synchronous so the caller can broadcast
  `agent_deleted` once every store is purged (ADR-0030 D6).
  """
  def delete(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:delete, agent_id})
  end

  @impl true
  def init({name, path}) do
    path |> Path.dirname() |> File.mkdir_p!()
    table = open_table(name, path)
    # Records may carry a custom name the operator picked. Keep the file
    # owner-only so the default /tmp location is not world-readable on a
    # shared host — matches SessionPointers' chmod discipline.
    _ = File.chmod(path, 0o600)
    {:ok, %{table: table, entries: load_entries(table)}}
  end

  # A corrupt/unreadable DETS file must not crash-loop the supervisor.
  # On a failed open, drop the file and recreate it empty — losing entries
  # only costs the operator the ability to restore agents that spawned
  # before the corruption, and forces a fresh spawn per agent to seed
  # again.
  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, reason} ->
        Logger.warning("agent directory store unreadable (#{inspect(reason)}); recreating")

        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  defp load_entries(table) do
    case :dets.foldl(&load_fold/2, %{}, table) do
      entries when is_map(entries) -> entries
      {:error, _reason} -> %{}
    end
  end

  # Two clauses, not one, so a DETS file written before `revision` shipped
  # (a bare `{agent_id, persona}` 2-tuple) still loads instead of crashing
  # `:dets.foldl/3` on a pattern-match failure (issue #197 段階3): an old
  # record defaults to `revision: 0`, the same starting value `record/3`
  # gives every freshly-created entry, so it compares correctly against
  # the first rename either way.
  #
  # The persisted `revision` is re-validated on load, not trusted as-is
  # (ふじ MF-4/MF-5 レビュー指摘): `rename/3` does `revision + 1` on
  # whatever this returns, so a non-integer value would crash that
  # arithmetic, and a corrupted/out-of-domain value (negative, or a
  # magnitude past `@max_safe_revision` from disk corruption) would
  # carry forward into the `persona_sync` relay a wrapper compares
  # against — the same 0..@max_safe_revision domain `transport.ts`'s
  # narrow enforces on the wire. Both bounds are checked here: MF-4
  # closed the lower bound; MF-5 closed the upper one, which this clause
  # previously claimed to check ("implausibly large ... falls back to
  # 0") without actually comparing against any ceiling — an
  # out-of-range-but-positive persisted value passed straight through
  # and, since every wrapper's narrow drops it on receipt, left that
  # agent's persona permanently unable to converge. Falls back to 0 (the
  # same baseline a fresh `record/3` gives), not a crash or an unchecked
  # passthrough.
  defp load_fold({agent_id, persona, revision}, acc) do
    safe_revision =
      if is_integer(revision) and revision >= 0 and revision <= @max_safe_revision,
        do: revision,
        else: 0

    Map.put(acc, agent_id, %{persona: persona, last_seen: nil, revision: safe_revision})
  end

  defp load_fold({agent_id, persona}, acc) do
    Map.put(acc, agent_id, %{persona: persona, last_seen: nil, revision: 0})
  end

  @impl true
  def handle_cast({:record, agent_id, persona}, state) do
    case Map.get(state.entries, agent_id) do
      nil ->
        # Fresh agent_id — the only expected case (agent_id is newly
        # allocated per spawn, ADR-0024 D3). Starts revision at 0.
        :ok = :dets.insert(state.table, {agent_id, persona, 0})
        entry = %{persona: persona, last_seen: nil, revision: 0}
        {:noreply, %{state | entries: Map.put(state.entries, agent_id, entry)}}

      _existing ->
        # Create-only (issue #197 段階3, ふじ MF-2 レビュー指摘): an
        # existing entry is never touched by `record/3` again, matched or
        # not — see `record/3`'s own doc for why. `rename/3` is the sole
        # mutation path once an entry exists.
        {:noreply, state}
    end
  end

  def handle_cast({:touch, agent_id, ts}, state) do
    case Map.get(state.entries, agent_id) do
      nil ->
        # No persona recorded yet (envelope from a wrapper that pre-dates
        # the AgentDirectory rollout, or a race where envelope arrives
        # before the spawn cast). Skip — restore needs persona first, and
        # the next spawn (or the wrapper's next envelope carrying persona)
        # will seed it.
        {:noreply, state}

      entry ->
        {:noreply, %{state | entries: Map.put(state.entries, agent_id, %{entry | last_seen: ts})}}
    end
  end

  @impl true
  def handle_call({:get, agent_id}, _from, state) do
    {:reply, Map.get(state.entries, agent_id), state}
  end

  def handle_call(:all, _from, state) do
    {:reply, state.entries, state}
  end

  def handle_call({:delete, agent_id}, _from, state) do
    :ok = :dets.delete(state.table, agent_id)
    {:reply, :ok, %{state | entries: Map.delete(state.entries, agent_id)}}
  end

  def handle_call({:rename, agent_id, name}, _from, state) do
    case Map.get(state.entries, agent_id) do
      nil ->
        {:reply, {:error, :not_found}, state}

      # Fail-closed wire-domain ceiling (issue #197 段階3, ふじ MF-5
      # レビュー指摘): at `@max_safe_revision`, bumping further would
      # emit a revision past every wrapper's `persona_sync` narrow.
      # Reject explicitly — no DETS write, no broadcast, no relay —
      # rather than either crashing (no catch-all clause below) or
      # silently succeeding at the same revision (which would just
      # reproduce the MF-2/MF-3 divergence under a new trigger).
      %{revision: revision} when revision >= @max_safe_revision ->
        {:reply, {:error, :revision_exhausted}, state}

      %{persona: persona, revision: revision} = entry ->
        new_revision = revision + 1
        new_persona = Map.put(persona, "name", name)
        :ok = :dets.insert(state.table, {agent_id, new_persona, new_revision})
        new_entry = %{entry | persona: new_persona, revision: new_revision}
        new_entries = Map.put(state.entries, agent_id, new_entry)

        # D16/MF-3 (issue #197 段階3, ふじ レビュー指摘): broadcasting
        # from INSIDE this GenServer — synchronously, as part of the SAME
        # serialized call that performs the write — is what guarantees
        # broadcast order matches write order. The previous design
        # broadcast from the CALLER (`agents_channel.ex`) after this call
        # returned; that left a window where two `AgentsChannel`
        # processes could each finish their own (correctly serialized)
        # `rename` call but then race each other to issue the FOLLOWING
        # `AgentDirectory.all/1` snapshot + broadcast, letting an OLDER
        # snapshot's broadcast reach already-joined operator dashboards
        # AFTER a newer one. The wrapper's own revision guard (D15)
        # protects `persona_sync` against exactly this reordering, but
        # the dashboard's `directory` copy had no such defense — it reads
        # no revision (`dashboard/src/lib/protocol.ts` `parseDirectory`)
        # and merges by wholesale replace (`App.svelte`'s `onDirectory`).
        # Doing the read + broadcast here, inside the same mailbox that
        # serializes every write, removes the race instead of requiring
        # the client to detect and drop a stale event.
        KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "directory", %{
          "entries" => new_entries
        })

        {:reply, {:ok, new_entry}, %{state | entries: new_entries}}
    end
  end

  @impl true
  def terminate(_reason, state) do
    :dets.close(state.table)
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :agent_directory_path) ||
      Path.join(System.tmp_dir!(), "kaoiro_agent_directory.dets")
  end
end
