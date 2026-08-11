defmodule KaoiroServer.AgentDirectory do
  @moduledoc """
  Restart-surviving identity ledger — `agent_id => %{persona_id,
  display_name, last_seen, revision}` (ADR-0030, revised issue #219 D19).
  Persists a pure instance-state record so operator-driven restore
  (`agents_channel.ex agent_persona/1`) still works after a server
  restart when `AgentStates` is empty. Mirrors the `SessionPointers` /
  `PermissionModes` shape: tiny payload, DETS-backed, in-memory mirror
  for fast reads. Both mutating calls — `record/4` (spawn path) and
  `rename/3` — are synchronous `GenServer.call`s (issue #219 D22
  corollary for `record/4`; `rename/3` was already synchronous, see its
  own doc for why); `touch/2` (the `last_seen` hint) remains the only
  fire-and-forget `GenServer.cast` in this module.

  **This module does NOT store canonical persona data** (`persona.name`
  / `sprite_set`) — issue #219 D19. The canonical persona is a property
  of the PACK, not of an agent instance; its sole SoT is the current
  `KaoiroServer.PersonaAssets` manifest, keyed by `persona_id`. What
  THIS module persists is exactly the two things that ARE per-instance
  state: the stable `persona_id` reference, and the mutable
  `display_name` (ADR-0050 D1 `Principal.display_name`). Any caller that
  needs the canonical name/sprite_set for display (restore payloads,
  directory projection, wrapper spawn payloads) joins `persona_id`
  against `PersonaAssets` itself — that join is deliberately NOT done in
  this module (see D19/D21 in issue #219's spec-gate decision; keeping
  this ledger free of a PersonaAssets dependency keeps its tests
  independent of pack state and keeps the dependency direction
  persistence-layer -> asset-layer, never the reverse).

  `persona_id`, `display_name`, and `revision` are all written to disk
  (`last_seen` stays memory-only, see below). `revision` is a monotonic
  per-agent_id counter bumped ONLY by `rename/3` (issue #197 段階3,
  D12/D15): it lets a wrapper that receives two rename relays out of
  order (broadcast delivery has no ordering guarantee across two
  different `AgentsChannel` processes) drop the stale one instead of
  rolling back to an older name. `record/4` is deliberately create-only
  (ふじ MF-2 レビュー指摘, see its own doc) so it can never contend with
  `rename/3` for revision authority — `rename/3` is the sole mutation
  path for an entry that already exists. The counter is NOT a
  general-purpose optimistic-lock token — nothing else in this module
  reads or compares it.

  `last_seen` is a memory-only unix seconds hint the client uses to
  grade "recently online" vs "long offline" — losing it on restart is
  fine (all reloaded entries look offline until the wrapper reconnects
  and touches them). Persisting every envelope's timestamp would put the
  ingest path on the disk write budget for no additional recovery value.
  """

  use GenServer

  require Logger

  # Wire-domain upper bound for `revision` — the same JS
  # `Number.MAX_SAFE_INTEGER` boundary `transport.ts`'s `persona_sync` /
  # `display_name_sync` narrows enforce (2^53 - 1). `rename/3` must never
  # emit a revision past this: doing so would produce a value every
  # wrapper's narrow drops on receipt, leaving that agent's persona
  # permanently unable to converge (issue #197 段階3, ふじ MF-5 レビュー
  # 指摘).
  @max_safe_revision 9_007_199_254_740_991

  # Baseline for a brand-new entry, and the floor every loaded revision is
  # clamped up to (issue #219 MF-2, クロエ実測検証). NOT 0 — a legacy
  # (pre-issue-#219) wrapper build starts its own counter at
  # `#personaRevision = 0` and drops any sync push with `revision <= 0`
  # (`if (revision <= this.#personaRevision) return;`). A fresh spawn's
  # revision-0 entry would therefore push its FIRST persona_sync /
  # display_name_sync at revision 0, which such a wrapper silently drops
  # as "not newer" — a spawn custom name never converges for that
  # new-server / old-wrapper pairing. Starting at 1 (and lifting any
  # already-persisted revision 0 up to 1 on load, see `clamp_revision/1`)
  # guarantees the first push a legacy wrapper ever sees compares strictly
  # greater than its own baseline. `revision` is a monotonic order token,
  # not a rename count, so shifting the floor changes no other semantics.
  @initial_revision 1

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
  Records a NEW agent's identity at revision @initial_revision (issue
  #219 MF-2 — see module doc for why not 0): `persona_id` (the stable
  reference into `PersonaAssets`, issue #219 D19) and `display_name`
  (already resolved by the caller — spawn custom name, or the pack's
  current canonical name copied at record time, D20; this module does
  no fallback resolution of its own).

  Synchronous (`GenServer.call`, issue #219 D22 — was fire-and-forget
  `GenServer.cast` before this): the caller (`agents_channel.ex`'s spawn
  handler) MUST have this write committed before it broadcasts `spawn` to
  the runner, or a wrapper that joins immediately after launch can race
  ahead of the cast still sitting in this GenServer's mailbox —
  `wrapper_channel.ex`'s after-join `push_persona_sync/2` would then read
  `AgentDirectory.get/1` as `nil` and skip the sync entirely (silently,
  not retried), and an operator `rename_agent` landing in the same window
  would see `{:error, :not_found}` even though the agent visibly exists.
  Making this call synchronous, ordered strictly BEFORE the spawn
  broadcast, closes that window: by the time any wrapper process can
  possibly exist and join, the entry is already committed.

  Create-only (issue #197 段階3, ふじ MF-2 レビュー指摘): an `agent_id`
  that already has an entry is left untouched, unconditionally — this
  call never overwrites an existing entry's `persona_id` / `display_name`
  / `revision`, even when the incoming values differ from what is
  stored. Before this fix (predating issue #219), a duplicate/delayed
  `record/3` for an existing id (e.g. a retried or racing spawn call)
  bumped `revision` and overwrote the entry; since `rename/3` ALSO bumps
  `revision`, a stray delayed `record` landing after a `rename` could
  carry a HIGHER revision than the rename while reverting to the
  pre-rename name — a wrapper applying a sync push afterward would
  accept it as "newer" and roll the display name back, exactly the
  outcome D15's revision guard exists to prevent. In normal operation
  this defensive branch was never expected to fire anyway: `agent_id` is
  newly allocated per spawn (ADR-0024 D3) and `record/4` is called
  exactly once per spawn, so a second call for the same id already
  implied something unusual — making it a safe no-op removes the
  failure mode entirely rather than trying to out-guess it.
  """
  def record(agent_id, persona_id, display_name, server \\ __MODULE__)
      when is_binary(persona_id) and is_binary(display_name) do
    GenServer.call(server, {:record, agent_id, persona_id, display_name})
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
  Latest entry `%{persona_id, display_name, last_seen, revision}` for the
  agent, or nil. `last_seen` is nil until the wrapper's first envelope
  after the current process start (fresh load / restart). Callers that
  need the canonical persona (name / sprite_set) for display join
  `persona_id` against `PersonaAssets` themselves (issue #219 D19) — this
  function never does that join.
  """
  def get(agent_id, server \\ __MODULE__) do
    GenServer.call(server, {:get, agent_id})
  end

  @doc "agent_id => %{persona_id, display_name, last_seen, revision} for every known entry."
  def all(server \\ __MODULE__) do
    GenServer.call(server, :all)
  end

  @doc """
  Renames the agent's `display_name` (issue #197 段階3 D12, revised
  issue #219 D19/D23 — the mutated field is `display_name`, never
  canonical persona data). `display_name` must already be
  trimmed/validated by the caller (`agents_channel.ex`'s rename
  validation, same 64-grapheme / control-char rule spawn-time custom
  naming uses) — this function only rejects an unknown `agent_id`, it
  does not re-validate the value's shape (same division of labor
  `record/4` already has with its caller-built arguments).

  Synchronous (`GenServer.call`, same as `record/4` since issue #219 D22
  — see that function's own doc) for two reasons: the caller needs the
  bumped `revision` back before it can relay the rename to the wrapper
  (D15 — the revision is what lets a wrapper drop an out-of-order
  relay), and two concurrent renames of the same agent must serialize
  through this single GenServer's mailbox rather than racing each
  other's disk writes.

  Returns `{:ok, %{persona_id:, display_name:, revision:}}` (the updated
  entry), `{:error, :not_found}` for an agent_id this ledger has never
  recorded (never spawned, or already deleted), or `{:error,
  :revision_exhausted}` when the entry's current revision already sits
  at `@max_safe_revision` (issue #197 段階3, ふじ MF-5 レビュー指摘):
  bumping it further would emit a `revision` outside the wire's
  safe-integer domain, which every wrapper's narrow drops on receipt —
  permanently stranding that agent's persona. Fail-closed: the entry is
  left completely untouched (no DETS write, no broadcast, no relay)
  rather than silently succeeding at the same revision, which would just
  reproduce the MF-2/MF-3 divergence under a new trigger.
  """
  def rename(agent_id, display_name, server \\ __MODULE__) when is_binary(display_name) do
    GenServer.call(server, {:rename, agent_id, display_name})
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

  # Current shape (issue #219 D19): `persona_id` and `display_name` are
  # independent scalars, no persona map. The persisted `revision` is
  # re-validated on load, not trusted as-is (ふじ MF-4/MF-5 レビュー指
  # 摘, carried over from issue #197 段階3) — see `clamp_revision/1`.
  #
  # `agent_id` MUST also be binary (issue #219 MF-6, ふじ最終レビュー指
  # 摘): round 1's catch-all fail-soft only covers a shape mismatch on
  # the OTHER 3 elements — without this guard, a non-binary agent_id
  # (e.g. a corrupted map/atom) would still match this clause, land in
  # the in-memory `entries` map keyed by a non-string, and carry that
  # corruption forward into directory broadcast / JSON projection
  # instead of being caught here.
  defp load_fold({agent_id, persona_id, revision, display_name}, acc)
       when is_binary(agent_id) and is_binary(persona_id) and is_binary(display_name) do
    Map.put(acc, agent_id, %{
      persona_id: persona_id,
      display_name: display_name,
      last_seen: nil,
      revision: clamp_revision(revision)
    })
  end

  # Legacy shape (issue #197 段階3): a persona MAP was baked into the
  # entry instead of a bare `persona_id` reference, and `persona["name"]`
  # carried whatever `apply_custom_name/2` / `rename/3` had already
  # destructively written over the pack's canonical name (issue #219's
  # whole premise — see the issue body's "現物での裏付け"). Migration is
  # UNCONDITIONAL, never a guess (issue #219 D21):
  #
  #   - `display_name` := the old `persona["name"]` value, verbatim. This
  #     can never be wrong in a way that loses information — whatever the
  #     field meant before (an untouched pack name, a spawn custom name,
  #     or a runtime rename), the operator-visible label carries forward
  #     unchanged.
  #   - `persona_id` := the old `persona["id"]` value, verbatim — this
  #     was always a stable reference, migration does not touch it.
  #   - The canonical name/sprite_set the old entry carried is DISCARDED,
  #     not migrated anywhere: issue #219 D19 stops storing canonical
  #     data in this ledger at all. Every reader that wants canonical
  #     data now joins `persona_id` against the pack's CURRENT manifest
  #     (`PersonaAssets`) instead of trusting a frozen snapshot — this is
  #     what makes the migration safe even though the old `persona.name`
  #     might not equal the current pack name (ふじ's rejected short-cut:
  #     re-resolving `persona.id` against the manifest to DECIDE whether
  #     the old value was "the pack name" or "a custom name" is not
  #     attempted here, or anywhere — see the issue #219 spec-gate D19/D21
  #     decision for why guessing was rejected outright).
  #
  #   `"name"` MUST be present and binary (issue #219 MF-5, クロエ実測検
  #   証): a record with `"id"` but no usable `"name"` does NOT fall back
  #   to inventing a display_name from `persona_id` — that would be
  #   exactly the kind of guess D21 already rejected for the canonical
  #   join, just relocated to this migration path. Such a record instead
  #   fails to match this clause (and the 2-tuple clause below) and falls
  #   through to the catch-all, which skips it with a warning.
  #
  #   `agent_id` MUST also be binary (issue #219 MF-6, ふじ最終レビュー
  #   指摘) — this clause's `Logger.warning` call below string-interpolates
  #   `#{agent_id}` directly (`Kernel.to_string/1`, no `String.Chars`
  #   implementation for a bare map), so a non-binary agent_id would not
  #   just carry corruption forward silently, it would raise
  #   `Protocol.UndefinedError` INSIDE `:dets.foldl`, crashing
  #   `AgentDirectory.init/1` and taking the whole ledger's boot down
  #   with it — precisely the regression round 1's catch-all fail-soft
  #   was meant to close, reopened on this one path (measured directly:
  #   `elixir -e 'IO.puts("x #{%{bad: true}}")'` raises;
  #   `bddbcec`'s pre-#219 `load_fold` never interpolated `agent_id` at
  #   all, so it never had this failure mode).
  defp load_fold({agent_id, %{"id" => persona_id, "name" => display_name}, revision}, acc)
       when is_binary(agent_id) and is_binary(persona_id) and is_binary(display_name) do
    Logger.warning(
      "agent directory migration (issue #219): #{agent_id} legacy persona map " <>
        "migrated to persona_id=#{inspect(persona_id)} display_name=#{inspect(display_name)}"
    )

    Map.put(acc, agent_id, %{
      persona_id: persona_id,
      display_name: display_name,
      last_seen: nil,
      revision: clamp_revision(revision)
    })
  end

  # Even older shape (pre issue #197 段階3, no revision at all) — same
  # unconditional migration and same `"name"` presence/binary requirement
  # as the 3-tuple clause above (issue #219 MF-5), starting revision at
  # @initial_revision (the same baseline `record/4` gives every
  # freshly-created entry, issue #219 MF-2). Also requires `agent_id`
  # binary for the same reason as the 3-tuple clause above (issue #219
  # MF-6) — this clause's own `Logger.warning` below interpolates
  # `agent_id` too.
  defp load_fold({agent_id, %{"id" => persona_id, "name" => display_name}}, acc)
       when is_binary(agent_id) and is_binary(persona_id) and is_binary(display_name) do
    Logger.warning(
      "agent directory migration (issue #219): #{agent_id} legacy persona map " <>
        "migrated to persona_id=#{inspect(persona_id)} display_name=#{inspect(display_name)}"
    )

    Map.put(acc, agent_id, %{
      persona_id: persona_id,
      display_name: display_name,
      last_seen: nil,
      revision: @initial_revision
    })
  end

  # Catch-all (issue #219 must-fix, クロエ実測検証 2026-08-11): none of the
  # 3 shapes above matched — a corrupted DETS record, or some other shape
  # entirely. The 3 clauses above are now all guard-gated (issue #219
  # D21 replaced the old unguarded 2-tuple/3-tuple clauses with
  # `is_binary` guards), so an unrecognised record no longer matches one
  # of them by accident — it falls through to here instead of raising
  # `FunctionClauseError` inside `:dets.foldl`. Skip it and keep loading
  # the rest of the table: one corrupted record must not crash the whole
  # ledger's boot (`AgentDirectory.init/1` calling `load_entries/1`) and
  # send the server into a restart loop — the same fail-soft posture
  # `clamp_revision/1` below already takes for a corrupted revision
  # alone, just extended to a corrupted/unrecognised record shape.
  defp load_fold(other, acc) do
    Logger.warning("agent directory: skipping unrecognised DETS record #{inspect(other)}")
    acc
  end

  # A persisted `revision` outside @initial_revision..@max_safe_revision
  # falls back to @initial_revision (the same baseline a fresh `record/4`
  # gives), not a crash or an unchecked passthrough — `rename/3` does
  # `revision + 1` on whatever this returns, so a non-integer would crash
  # that arithmetic, and an out-of-domain value would carry forward into a
  # sync push every wrapper's narrow drops on receipt, permanently
  # stranding that agent's persona (issue #197 段階3, ふじ MF-4/MF-5 レビュ
  # ー指摘). This ALSO lifts a legitimately-persisted `0` (the pre-issue-
  # #219 MF-2 baseline) up to @initial_revision on load — see the module
  # doc's `@initial_revision` note for why a bare 0 can no longer be
  # trusted as a safe first-sync-push value for a legacy wrapper build.
  defp clamp_revision(revision) do
    if is_integer(revision) and revision >= @initial_revision and
         revision <= @max_safe_revision,
       do: revision,
       else: @initial_revision
  end

  @impl true
  def handle_cast({:touch, agent_id, ts}, state) do
    case Map.get(state.entries, agent_id) do
      nil ->
        # No entry recorded yet (envelope from a wrapper that pre-dates
        # the AgentDirectory rollout, or a race where envelope arrives
        # before the spawn cast). Skip — restore needs an entry first, and
        # the next spawn (or the wrapper's next envelope) will seed it.
        {:noreply, state}

      entry ->
        {:noreply, %{state | entries: Map.put(state.entries, agent_id, %{entry | last_seen: ts})}}
    end
  end

  @impl true
  def handle_call({:record, agent_id, persona_id, display_name}, _from, state) do
    case Map.get(state.entries, agent_id) do
      nil ->
        # Fresh agent_id — the only expected case (agent_id is newly
        # allocated per spawn, ADR-0024 D3). Starts revision at
        # @initial_revision (issue #219 MF-2 — see module doc for why
        # not 0).
        :ok =
          :dets.insert(state.table, {agent_id, persona_id, @initial_revision, display_name})

        entry = %{
          persona_id: persona_id,
          display_name: display_name,
          last_seen: nil,
          revision: @initial_revision
        }

        {:reply, :ok, %{state | entries: Map.put(state.entries, agent_id, entry)}}

      _existing ->
        # Create-only (issue #197 段階3, ふじ MF-2 レビュー指摘): an
        # existing entry is never touched by `record/4` again, matched or
        # not — see `record/4`'s own doc for why. `rename/3` is the sole
        # mutation path once an entry exists.
        {:reply, :ok, state}
    end
  end

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

  def handle_call({:rename, agent_id, display_name}, _from, state) do
    case Map.get(state.entries, agent_id) do
      nil ->
        {:reply, {:error, :not_found}, state}

      # Fail-closed wire-domain ceiling (issue #197 段階3, ふじ MF-5
      # レビュー指摘): at `@max_safe_revision`, bumping further would
      # emit a revision past every wrapper's sync-push narrow. Reject
      # explicitly — no DETS write, no broadcast, no relay — rather than
      # either crashing (no catch-all clause below) or silently
      # succeeding at the same revision (which would just reproduce the
      # MF-2/MF-3 divergence under a new trigger).
      %{revision: revision} when revision >= @max_safe_revision ->
        {:reply, {:error, :revision_exhausted}, state}

      %{persona_id: persona_id, revision: revision} = entry ->
        new_revision = revision + 1
        :ok = :dets.insert(state.table, {agent_id, persona_id, new_revision, display_name})
        new_entry = %{entry | display_name: display_name, revision: new_revision}
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
        # AFTER a newer one.
        #
        # The broadcast payload here is the RAW `persona_id` +
        # `display_name` entries — no canonical join (issue #219 D19).
        # Joining `persona_id` against `PersonaAssets` here would give
        # this module a PersonaAssets dependency, which the whole point
        # of D19 is to avoid (persistence-layer -> asset-layer is the
        # wrong direction, and it would make this ledger's tests depend
        # on pack state). The join happens downstream, in
        # `AgentsChannel.handle_out("directory", ...)` (an intercepted
        # event, so every subscriber's OWN channel process runs it after
        # receiving this broadcast) — NOT re-reading `AgentDirectory`,
        # just joining the `persona_id` already in this payload against
        # the CURRENT `PersonaAssets` manifest. That keeps this
        # broadcast's ordering guarantee intact: each subscriber's
        # mailbox delivers broadcasts in the order this GenServer sent
        # them, and `handle_out` processes them in that same order — it
        # never goes back to ask this module for anything, so it cannot
        # reorder or race a later write. (A pack reload landing between
        # this broadcast and a subscriber's `handle_out` can make that
        # subscriber join a NEWER canonical than what was current at
        # broadcast time — harmless, since newer is correct, and it does
        # not touch `display_name`/`revision` ordering at all.)
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
