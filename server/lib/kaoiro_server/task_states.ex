defmodule KaoiroServer.TaskStates do
  @moduledoc """
  In-memory nested table of active subagent/workflow tasks (issue #180,
  ADR-0019 F1-F4 / ADR-0047 / ADR-0048 F1).

  Keyed by `agent_id => %{task_id => envelope}` on the WIRE (`snapshot/0`'s
  return value); internally each leaf is a `{wire_size, envelope}` tuple
  (M1 round-2 perf fix below; `wire_size` is `entry_wire_size/2`'s result
  as of the round-3 fix, not the leaf-only `encoded_size/1`) that
  `snapshot/0` unwraps before replying.
  Each leaf is the LATEST `type=task` envelope for that (agent_id, task_id)
  pair. M1 fix-round (2026-08-09, ふじ review): ADR-0047 F2 only promises
  `task_id` is unique WITHIN one parent session, not globally — a flat
  `task_id`-only
  key (the original design) let two different agents' tasks collide,
  with one agent's `completed` silently erasing another agent's still-
  running task of the same id. The (agent_id, task_id) composite key
  closes that: identity now matches the ADR's own uniqueness promise,
  `discard_for_agent/1` becomes an O(1) top-level delete instead of a
  linear scan, and this table is deliberately NOT folded into
  `AgentStates`' one-envelope-per-agent_id slot — a `task` envelope is a
  distinct child entity's lifecycle, not the parent's own `state_change`
  (ADR-0048 F1's "フラットな task テーブル + 親 agent_id 参照", ADR-0019
  F1's parent-linked child-entity model — "フラット" here means no
  nesting of tasks under OTHER tasks, not that the whole table has to be
  a single-level map keyed only by task_id).

  `put/1` handles all three `payload.kind` values (ADR-0047 F1):
  `started`/`updated` upsert the task's latest envelope; `completed`
  removes it (pruning the agent's now-empty inner map too) — mirroring
  the wrapper-side +1/-1 concurrency accounting (ADR-0019 F4), so this
  table's total entry count IS the active-task count with no separate
  counter to keep in sync by hand (an internal `count` field tracks it
  incrementally so the S2 cap check below is O(1)). A malformed payload
  (missing/empty `agent_id`/`task_id`, or an unrecognized `kind`) is
  logged and dropped rather than upserted/deleted or crashing the
  GenServer — fail-visible, matching the wrapper's own #180 policy for
  its analogous cases. The malformed-drop log (S3 fix-round) reports
  only which required fields were present/well-typed, never
  `inspect(envelope)` whole — the same content-boundary the
  prompt/output_file non-wiring decision draws (ADR-0047 addendum).

  S2 fix-round (2026-08-09): `@max_tasks` bounds the table's total entry
  count. `WrapperChannel.validate_task_payload/2` (S1 fix-round) already
  rejects a malformed task envelope at the frame boundary before it ever
  reaches here, but nothing there bounds CARDINALITY — a single
  well-formed-but-abusive wrapper could still spam unboundedly many
  distinct `task_id`s under its own (validated) `agent_id`. A NEW
  (agent_id, task_id) pair is rejected with `{:error, :too_many_tasks}`
  once at cap (mirrors `AgentStates`'s `@max_agents` cap contract).

  M1 fix-round (2026-08-09, ふじ round 2): `@max_tasks` alone bounds
  entry COUNT, not the resource the cap exists to protect — the join
  snapshot's actual wire size (`AgentsChannel`'s
  `push(socket, "snapshot", %{"tasks" => TaskStates.snapshot(), ...})`,
  bounded by `Endpoint`'s `max_frame_size: 8_000_000`).
  `WrapperChannel`'s `@max_envelope_bytes` (65_536) caps each INBOUND
  envelope by `:erlang.external_size/1`, but the outbound wire format is
  JSON (Jason) — ふじ's own measurement showed 62 individually
  ingress-cap-compliant envelopes JSON-encoding to 8,072,535 bytes,
  already past the frame limit, while `@max_tasks` (5000) would have let
  ~80x that many accumulate. `@max_task_snapshot_bytes` tracks the
  running total JSON-encoded byte size incrementally (mirrors `count`)
  and rejects ANY transition — a brand new pair OR an update to an
  already-tracked pair — that would push the total past budget. The
  "update to an already-tracked pair always succeeds" semantics from the
  original S2 fix-round is REVOKED here: an update can grow the envelope
  (e.g. a longer progress summary) enough on its own to blow the budget
  with no new key added, so it must be checked too.

  M1 round-3 fix (2026-08-09, ふじ round 3): the round-2 accounting above
  measured only each leaf ENVELOPE's own JSON size — it missed that the
  wire snapshot's shape, `%{agent_id => %{task_id => envelope}}`, makes
  `task_id` appear a SECOND time as the outer per-task JSON *key*
  (`"<task_id>":<envelope>,`), which `task_id` has no length cap of its
  own to bound. ふじ's measurement: 96 individually ingress-cap-compliant
  envelopes produced an ACTUAL snapshot of 11.9MB — past the frame limit
  again, despite a tracked `bytes` total safely under the 6MB budget.
  `entry_wire_size/2` now charges each entry for the task_id key's own
  JSON form (plus its colon and a separator) on top of the leaf, so
  `bytes` tracks the real per-entry wire contribution instead of only
  the leaf. `WrapperChannel.validate_task_payload/2` also gained a
  length cap on `task_id` (`@max_task_id_field_bytes`, 256) — this
  bounds the now-measured task_id key. `agent_id` needed no analogous
  NEW cap: it already inherits `KaoiroServerWeb.AgentId.valid?/1`'s
  (issue #61) pre-existing 1..256-char bound via the topic-match guard,
  which `@max_task_snapshot_bytes`'s margin comment cites for the
  per-AGENT key overhead this module still does NOT charge per-entry
  (see that comment for the arithmetic). Reject-path log messages were
  also changed to a bounded preview (`log_preview/1`) rather than
  interpolating `task_id`/`agent_id` directly — even with the new
  ingress cap, this module must not assume that cap is the only thing
  standing between it and an unbounded log line (defense in depth;
  ふじ's own measurement of the PRE-cap log line: 62KB in one entry).

  `discard_for_agent/1` (ADR-0048 F1's "親エージェントの離脱時には紐づく
  task を破棄する") drops every task belonging to one parent agent_id.
  Called from `WrapperChannel.terminate/2`'s live-disconnect branch
  ONLY, and — as of the M3 fix-round (2026-08-09) — BEFORE that
  branch's `disconnected` broadcast, not after: a client that joins in
  the narrow window around a disconnect must see this table already
  purged by the time it could possibly observe the broadcast (or have
  missed it entirely because it joined earlier still, in which case
  nothing changed for it). Reordering after `broadcast` (the original
  #180 design) left a real gap — a join whose `snapshot` read landed
  between the broadcast and the (then-later) discard call could receive
  already-broadcast-as-gone tasks and never get told, because the one
  `disconnected` broadcast for that agent had already passed. This
  module does not track connection ownership itself; it piggybacks on
  `AgentStates.disconnect/3`'s own owner-checked success (a stale
  terminate after a reconnect must not discard the NEW connection's
  active tasks) rather than duplicating that check here.

  `snapshot/0` feeds the join-time `snapshot` push's `tasks` key
  (ADR-0048 F3 — no dedicated periodic snapshot envelope). The wire
  shape is `%{agent_id => %{task_id => envelope}}` (protocol.md);
  `snapshot/0` unwraps the internal `{wire_size, envelope}` tuples
  before replying (see below).

  M1 round-2 perf fix (2026-08-09, code review): the byte-budget
  mechanism originally re-derived every size via `Jason.encode!/1` on
  demand — once per `updated` envelope (to learn the SIZE OF THE ENTRY
  BEING REPLACED, which was already known when that entry was last
  written) and once per removed entry on `discard_for_agent/1` (up to
  `@max_tasks` = 5000 re-encodes in one `GenServer.call`, on the single
  process that serializes every agent's put/discard/snapshot traffic —
  a mass-disconnect could stall unrelated agents). Each leaf now stores
  its own size ALONGSIDE the envelope as it is written (round-3 fix
  below changed WHAT that cached size measures — `entry_wire_size/2`,
  not the leaf-only `encoded_size/1` this section originally described
  — but not the caching mechanism itself), so an update/removal looks
  the old size up instead of re-deriving it, and `discard_for_agent/1`
  sums already-known integers. `snapshot/0` pays the (cheap, no
  re-encoding) cost of unwrapping the tuples on the way out, which is
  fine — it runs once per operator join, not once per task event.
  """

  use GenServer

  require Logger

  # S2 fix-round (2026-08-09): total (agent_id, task_id) pair cap across
  # the whole table. Sized above AgentStates' @max_agents (1000) since a
  # single agent may legitimately run several concurrent subagents/
  # workflows; still bounds worst-case memory from a single abusive
  # wrapper spamming distinct task_ids under its own agent_id.
  @max_tasks 5000

  # M1 fix-round (2026-08-09, ふじ round 2/3): budget for THIS table's
  # (the task subtree's) own total JSON-encoded byte size (see moduledoc
  # M1 sections) — NOT a guarantee on the full `snapshot` push's overall
  # size. 6_000_000, not 8_000_000 (Endpoint's max_frame_size): the ~2MB
  # margin is reserved for two things THIS module does not directly
  # account for per-entry:
  #
  # 1. AgentStates' own "agents" key riding the same snapshot push —
  #    AgentStates has no byte budget of its own (unbounded per-entry
  #    content — e.g. `log`/`result`/`state_change` text fields carry no
  #    length cap on this path); bounding it is out of #180's scope. The
  #    2MB margin below is sized only against THIS module's own known
  #    per-agent-key overhead (item 2), not against AgentStates' size,
  #    which this module cannot see or bound. Consequently this budget
  #    caps the task subtree, not the combined `{agents, tasks}` push —
  #    an unbounded AgentStates snapshot can still blow the 8MB frame
  #    limit on its own regardless of what this module does. Tracked
  #    separately: issue #213 (combined byte bound, enhancement/
  #    priority-low; ふじ round-4 measurement: task subtree 7.23MB,
  #    leaving only ~770KB margin before the 8MB frame limit).
  # 2. THIS table's own per-AGENT outer key ("<agent_id>":{...},) —
  #    round-3 fix: `entry_wire_size/2` now charges each entry for its
  #    task_id key (the thing ふじ's round-3 measurement showed was
  #    missing), but charging the AGENT-level key per-entry would
  #    double-count it once per task instead of once per agent, so it is
  #    NOT in `bytes` and must be justified here instead. Worst case:
  #    @max_tasks (5000) pairs spread across 5000 DISTINCT agents (one
  #    task each — the worst distribution for this specific overhead),
  #    each `agent_id` at its PRE-EXISTING bound —
  #    `KaoiroServerWeb.AgentId.valid?/1` (issue #61) already restricts
  #    every agent_id to 1..256 chars of `[A-Za-z0-9._-]` at the wrapper
  #    JOIN boundary, and a task envelope's `payload.agent_id` must equal
  #    that topic-derived value (`WrapperChannel.validate_task_payload/2`),
  #    so it inherits the same bound with no new cap needed. Per agent:
  #    byte_size(Jason.encode!(agent_id)) <= 256 (content, no escaping
  #    needed for this charset) + 2 (quotes) = 258, plus 1 (colon) + 2
  #    (braces) + 1 (comma) = 262 bytes worst case. 5000 * 262 =
  #    1,310,000 bytes (~1.25MB) — comfortably inside the 2MB margin even
  #    stacked with (1) above.
  @max_task_snapshot_bytes 6_000_000

  # S1 fix-round (2026-08-09, ふじ round 3): reject/drop log lines below
  # interpolate task_id/agent_id. `WrapperChannel.@max_task_id_field_bytes`
  # bounds these at the ingress boundary now, but this module must not
  # assume that cap is the only thing standing between it and an
  # unbounded log line (a future caller, a loosened cap, or a bypass) —
  # ふじ's own measurement of the PRE-cap log line was 62KB in one entry.
  @log_preview_limit 80

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Upserts (kind started/updated) or removes (kind completed) the task
  referenced by one `type=task` envelope, keyed by (agent_id, task_id).
  Always returns `:ok`, EXCEPT: `{:error, :too_many_tasks}` when a brand
  new (agent_id, task_id) pair would exceed `@max_tasks` (S2), or
  `{:error, :task_snapshot_too_large}` when the transition — new pair OR
  update to an existing one — would push the table's total JSON-encoded
  byte size past `@max_task_snapshot_bytes` (M1 fix-round). Both mirror
  `AgentStates.put/2`'s cap contract, and `store_and_broadcast/4` already
  handles a `{:error, reason}` return generically (reply + no
  broadcast/record), so no caller-side change was needed for either.
  A malformed envelope is logged and dropped, never an error the caller
  must branch on.
  """
  def put(envelope, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:put, envelope})
  end

  @doc "Removes every task whose payload.agent_id matches (ADR-0048 F1)."
  def discard_for_agent(agent_id, opts \\ []) when is_binary(agent_id) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(server, {:discard_for_agent, agent_id})
  end

  @doc "Returns the agent_id => %{task_id => envelope} map (ADR-0048 F3, join snapshot)."
  def snapshot(server \\ __MODULE__), do: GenServer.call(server, :snapshot)

  @impl true
  def init(_opts), do: {:ok, %{tasks: %{}, count: 0, bytes: 0}}

  @impl true
  def handle_call({:put, envelope}, _from, state) do
    case task_ref(envelope) do
      {:ok, agent_id, task_id, kind} when kind in ["started", "updated"] ->
        upsert_task(state, agent_id, task_id, envelope)

      {:ok, agent_id, task_id, "completed"} ->
        {tasks, count, bytes} =
          drop_task(state.tasks, state.count, state.bytes, agent_id, task_id)

        {:reply, :ok, %{state | tasks: tasks, count: count, bytes: bytes}}

      {:ok, _agent_id, task_id, other_kind} ->
        Logger.warning(
          "TaskStates: unrecognized task kind=#{log_preview(other_kind)} for task_id=#{log_preview(task_id)} — dropped"
        )

        {:reply, :ok, state}

      :error ->
        Logger.warning(
          "TaskStates: malformed task envelope dropped (#{malformed_summary(envelope)})"
        )

        {:reply, :ok, state}
    end
  end

  def handle_call({:discard_for_agent, agent_id}, _from, state) do
    case Map.pop(state.tasks, agent_id) do
      {nil, _tasks} ->
        {:reply, :ok, state}

      {removed, tasks} ->
        # Perf fix (code review): sum the sizes already cached in each
        # {size, envelope} tuple — no re-encoding needed here.
        removed_bytes =
          removed |> Map.values() |> Enum.reduce(0, fn {size, _env}, acc -> acc + size end)

        {:reply, :ok,
         %{
           state
           | tasks: tasks,
             count: state.count - map_size(removed),
             bytes: state.bytes - removed_bytes
         }}
    end
  end

  def handle_call(:snapshot, _from, state), do: {:reply, unwrap_tasks(state.tasks), state}

  defp unwrap_tasks(tasks) do
    Map.new(tasks, fn {agent_id, agent_tasks} ->
      {agent_id, Map.new(agent_tasks, fn {task_id, {_size, envelope}} -> {task_id, envelope} end)}
    end)
  end

  defp upsert_task(state, agent_id, task_id, envelope) do
    agent_tasks = Map.get(state.tasks, agent_id, %{})
    new_size = entry_wire_size(task_id, envelope)

    case Map.fetch(agent_tasks, task_id) do
      :error ->
        upsert_new_task(state, agent_id, task_id, envelope, agent_tasks, new_size)

      {:ok, existing} ->
        upsert_existing_task(state, agent_id, task_id, envelope, agent_tasks, existing, new_size)
    end
  end

  defp upsert_new_task(state, agent_id, task_id, envelope, agent_tasks, new_size) do
    prospective_bytes = state.bytes + new_size

    cond do
      state.count >= @max_tasks ->
        reject(
          state,
          :too_many_tasks,
          "cap reached (#{@max_tasks}), rejecting new task_id=#{log_preview(task_id)} " <>
            "for agent_id=#{log_preview(agent_id)}"
        )

      prospective_bytes > @max_task_snapshot_bytes ->
        reject(
          state,
          :task_snapshot_too_large,
          "snapshot byte budget (#{@max_task_snapshot_bytes}) would be exceeded, " <>
            "rejecting new task_id=#{log_preview(task_id)} for agent_id=#{log_preview(agent_id)}"
        )

      true ->
        tasks =
          Map.put(state.tasks, agent_id, Map.put(agent_tasks, task_id, {new_size, envelope}))

        {:reply, :ok, %{state | tasks: tasks, count: state.count + 1, bytes: prospective_bytes}}
    end
  end

  defp upsert_existing_task(state, agent_id, task_id, envelope, agent_tasks, existing, new_size) do
    # Perf fix (code review): `existing` is the cached {size, envelope}
    # tuple this entry was stored with — read its size instead of
    # re-Jason-encoding the envelope we already know the size of.
    {existing_size, _existing_envelope} = existing
    prospective_bytes = state.bytes - existing_size + new_size

    if prospective_bytes > @max_task_snapshot_bytes do
      reject(
        state,
        :task_snapshot_too_large,
        "snapshot byte budget (#{@max_task_snapshot_bytes}) would be exceeded, " <>
          "rejecting update to task_id=#{log_preview(task_id)} for agent_id=#{log_preview(agent_id)}"
      )
    else
      tasks = Map.put(state.tasks, agent_id, Map.put(agent_tasks, task_id, {new_size, envelope}))
      {:reply, :ok, %{state | tasks: tasks, bytes: prospective_bytes}}
    end
  end

  defp reject(state, reason, log_message) do
    Logger.warning("TaskStates: #{log_message}")
    {:reply, {:error, reason}, state}
  end

  defp drop_task(tasks, count, bytes, agent_id, task_id) do
    case Map.get(tasks, agent_id) do
      nil ->
        {tasks, count, bytes}

      agent_tasks ->
        case Map.fetch(agent_tasks, task_id) do
          :error ->
            {tasks, count, bytes}

          {:ok, {size, _envelope}} ->
            agent_tasks = Map.delete(agent_tasks, task_id)

            # Prune the now-empty inner map too, so a fully-drained agent
            # does not leak an empty %{} entry in `tasks` forever.
            tasks =
              if map_size(agent_tasks) == 0 do
                Map.delete(tasks, agent_id)
              else
                Map.put(tasks, agent_id, agent_tasks)
              end

            # Perf fix (code review): cached size, no re-encoding.
            {tasks, count - 1, bytes - size}
        end
    end
  end

  # M1 fix-round (2026-08-09, ふじ round 2): the JSON text size, not
  # `:erlang.external_size/1` — the latter is what `WrapperChannel`'s
  # INGRESS cap measures, but the OUTBOUND wire format (this table's own
  # `snapshot/0`, pushed via Phoenix Channels) is JSON (Jason, per
  # config/config.exs), which runs noticeably larger for the same nested
  # map (ふじ's own measurement). `envelope` always originates from a
  # JSON-decoded Phoenix channel payload (plain maps/lists/strings/
  # numbers/bools/nil), so `Jason.encode!/1` cannot raise here.
  defp encoded_size(envelope), do: envelope |> Jason.encode!() |> byte_size()

  # M1 round-3 fix (2026-08-09, ふじ round 3): the leaf's OWN size
  # (`encoded_size/1`) undercounts its real wire contribution — on the
  # wire this entry also appears as `"<task_id>":<envelope>,` inside its
  # agent's inner map, so the task_id's OWN JSON-encoded key form (plus
  # the colon after it and a comma separator) is real wire weight too.
  # Charging a comma on every entry (not just non-last ones) is a
  # deliberate over-count, not an approximation error — this budget must
  # never UNDER-count, and over-counting can only reject a transition
  # earlier than strictly necessary, never admit an oversized snapshot.
  # `task_id` shares the same JSON-decoded-payload safety as `envelope`
  # (see encoded_size/1), so `Jason.encode!/1` cannot raise here either.
  defp entry_wire_size(task_id, envelope) do
    byte_size(Jason.encode!(task_id)) + 1 + encoded_size(envelope) + 1
  end

  defp task_ref(%{
         "type" => "task",
         "payload" => %{"agent_id" => agent_id, "task_id" => task_id, "kind" => kind}
       })
       when is_binary(agent_id) and agent_id != "" and is_binary(task_id) and task_id != "" and
              is_binary(kind) do
    {:ok, agent_id, task_id, kind}
  end

  defp task_ref(_), do: :error

  # S3 fix-round (2026-08-09, ふじ review): never `inspect(envelope)` a
  # whole malformed envelope into a log line — a payload that fails ONE
  # required field could still carry content-bearing OTHER fields
  # (summary, description). Report only the structural fact of which of
  # the 3 required identity fields were present and well-typed.
  defp malformed_summary(envelope) do
    payload = if is_map(envelope), do: Map.get(envelope, "payload"), else: nil

    "agent_id_present=#{present?(payload, "agent_id")} " <>
      "task_id_present=#{present?(payload, "task_id")} " <>
      "kind_present=#{is_map(payload) and is_binary(Map.get(payload, "kind"))}"
  end

  defp present?(payload, field) when is_map(payload) do
    case Map.get(payload, field) do
      v when is_binary(v) and v != "" -> true
      _ -> false
    end
  end

  defp present?(_payload, _field), do: false

  # S1 fix-round (2026-08-09, ふじ round 3): bounded preview for a log
  # line, instead of interpolating a raw string of unknown length.
  # `printable_limit` truncates (with a trailing "...") rather than
  # raising, and `inspect/2` also renders non-printable/binary content
  # safely, unlike direct string interpolation.
  defp log_preview(value), do: inspect(value, printable_limit: @log_preview_limit)
end
