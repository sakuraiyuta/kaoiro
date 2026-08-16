defmodule KaoiroServer.ConversationStates do
  @moduledoc """
  Per-conversation tracker for inter-agent messaging (protocol-inter-agent
  spec, phase-8 Stage B). In-memory only — a conversation that lives across
  a server restart starts fresh (Phase 2 / ADR-0014 will address durability).

  For each `conversation_id` we keep the turn count, the highest
  `turn_number` seen (`max_turn_number`, issue #177 review M1 — a
  wrapper-supplied sequence distinct from `turns`, which merely counts
  accepted messages), the running token approximation (`byte_size(body)
  ÷ 3` per message — protocol-inter-agent spec, intentionally coarse),
  the wallclock start time, the participating agent_id set, the set of
  agent_ids that have signalled `meta.done=true` so far, and the set
  already reported unreachable to their peers
  (`claim_unreachable_targets/3`, issue #131). `record_message/6`
  increments the counters and returns:

    * `:ok` — within limits, conversation still open.
    * `:both_done` — within limits, this message carried `done=true` and the
      counterpart side had already done so. The entry transitions atomically
      to a CLOSED tombstone (below); the caller relays the envelope but
      performs no further close.
    * `{:exceeded, reason}` — hard-limit overshoot (`:max_turns` / `:max_tokens`
      / `:max_concurrent_agents`). The entry transitions to a tombstone
      carrying that reason.
    * `{:error, :conversation_closed}` — a message arrived for a
      `conversation_id` that already holds a CLOSED tombstone (issue #177):
      a delayed / duplicate / out-of-order message reaching a conversation
      that already ended (both-done or a hard limit). Not relayed, stored,
      or broadcast — this is what stops a completed conversation from
      reopening into a done / escalate ping-pong.
    * `{:error, :stale_turn}` — `turn_number` is not greater than
      `max_turn_number` already recorded for this OPEN conversation (issue
      #177 review M1): a late, duplicate, or out-of-order delivery. The
      caller (channel ingress) only ever passes a positive integer here —
      `turn_number=0` is reserved for server-synthesized notices, which
      never reach this function (they are pushed directly, never submitted
      through the wrapper ingress path this function serves).
    * `{:error, :participants_mismatch}` — the sender/recipient pair is not
      part of an existing OPEN entry under that `conversation_id`
      (cross-conversation pollution defense, protocol-inter-agent
      threat-model).
    * `{:error, :too_many_conversations}` — the global `max_conversations` cap
      blocked a brand-new conversation; existing entries (open or
      tombstoned) are unaffected.
    * `{:error, :unknown_conversation_id}` — `new_conversation?` is false (the
      sender explicitly named this `conversation_id` rather than omitting
      it) and no entry exists for it, open or tombstoned (issue #262). A
      wrapper only omits the id when the CALLER omitted it too, so an
      explicit-but-unknown id here is a transcription error (a peer's id
      copied wrong, or a stale one from a prior session) — until this
      check, that typo silently opened a fresh, context-less conversation
      instead of surfacing the mistake. Never checked for
      `new_conversation? == true`: a freshly wrapper-allocated UUID is by
      construction absent from `state.conversations`, and always creates.

  A CLOSED tombstone (`status: :closed`) replaces the open entry in place
  under the same key: `reason` (why it closed), `closed_at` (monotonic ms,
  the TTL clock), `agents` (the former participant set) and `last_turn`
  (the turn count reached at closing) are kept for observability and for
  rejecting further sends; `tokens` / `started_at` / `done_by` /
  `max_turn_number` / `notified_unreachable` are dropped — a closed
  conversation never accepts another message, so nothing needs them again
  (`{:error, :conversation_closed}` is checked before `:stale_turn`, so a
  closed entry never needs its own turn bookkeeping). A tombstone still counts
  against `max_conversations` (bounded memory) and is excluded from
  `peer_index/1` and `claim_unreachable_targets/3` (not an active
  conversation).

  A periodic sweep (`:gc` self-message) transitions OPEN entries whose
  `started_at` is older than `open_conversation_ttl_ms` into an
  `:open_conversation_ttl` tombstone even without further messages —
  without it, a stale entry (issue #221: e.g. one side crashed or was
  never going to reply) would pin memory indefinitely. This is a
  memory-DoS defense only, distinct from the `{:exceeded, reason}` hard
  limits above: it never synthesizes an `escalate-to-user` envelope (the
  caller only does that for a `record_message/6` reply, and this
  transition happens out-of-band on the sweep), so a slow-but-legitimate
  conversation is not punished for taking a long time — see issue #221
  for why the previous `max_wallclock` hard-limit branch here was
  removed. The same sweep deletes tombstones once `tombstone_ttl_ms` has
  elapsed since `closed_at`, so a `conversation_id` may be reused for a
  brand-new conversation after that TTL (IDs are UUIDs, so this is not a
  permanent tombstone). Keeping this a separate key from
  `open_conversation_ttl_ms` matters for issue #177: the tombstone must
  outlive `open_conversation_ttl_ms` by enough margin that a genuinely
  late message cannot land on a freshly-reused `conversation_id`
  (wrapper-side `CLOSED_TRACK_TTL_MS` uses the same 24h value).
  """

  use GenServer

  require Logger

  # Sweep frequency for the wallclock-based GC of stale entries
  # (protocol-inter-agent memory-DoS defense). Set well below both
  # open_conversation_ttl_ms and tombstone_ttl_ms so an expired entry never
  # lingers more than the sweep interval.
  @gc_interval_ms 60_000

  @doc """
  Starts the tracker; tests can register an isolated instance via `:name`.

  `:clock` (issue #177 review nit2, AGENTS.md「Avoid Process.sleep/1 in
  tests」) overrides the monotonic-ms time source — a 0-arity function,
  default `&System.monotonic_time(:millisecond)/0`. Tests inject a
  deterministic clock (e.g. an `Agent` holding an integer) instead of
  sleeping real wallclock time to make GC / TTL behaviour observable.

  `:on_auto_closed` (issue #221 direction 2) is a 3-arity callback invoked
  once per conversation the periodic GC sweep auto-closes via
  `open_conversation_ttl_ms` (never for a hard-limit closure, which the
  caller of `record_message/6` already learns from its own return value):
  `fun.(conversation_id, participant_agent_ids, reason)`, `reason` always
  `:open_conversation_ttl` today. Default is a no-op — this module passes
  only that DATA, never wire vocabulary (`kind` / `owner` / `persona` /
  `display_name`); the real callback (wired in `KaoiroServer.Application`)
  is `KaoiroServerWeb.SynthEnvelope.deliver_conversation_closed/3`, which
  turns it into a broadcast envelope. Keeping this module's own
  `KaoiroServerWeb` dependency at zero is deliberate: every test below
  boots this GenServer alone, without the web layer.
  """
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    clock = Keyword.get(opts, :clock, &default_clock/0)
    on_auto_closed = Keyword.get(opts, :on_auto_closed, &default_on_auto_closed/3)
    GenServer.start_link(__MODULE__, {name, clock, on_auto_closed}, name: name)
  end

  defp default_clock, do: System.monotonic_time(:millisecond)
  defp default_on_auto_closed(_conversation_id, _agent_ids, _reason), do: :ok

  @doc """
  Records a new message in `conversation_id` from `from` to `to`, weighing
  the body for token accounting. `turn_number` is the sender's claimed
  sequence number for this message (issue #177 review M1) — the caller
  (channel ingress) validates it is a positive integer before this call;
  a value no greater than the conversation's already-recorded
  `max_turn_number` is rejected as `{:error, :stale_turn}` without
  advancing any counter (defense in depth: the channel already applies
  the same positive-integer rule at ingress, this is the OPEN-entry
  monotonicity check that rule alone cannot express). `done?` is
  `payload.meta.done` for this message — `true` records the sender as
  having signalled done; the entry only closes once every participating
  agent has done so (spec MUST: both owner-side done で対話完了). A
  message for an already-CLOSED `conversation_id` is rejected outright
  (`{:error, :conversation_closed}`, issue #177) — see the moduledoc for
  the tombstone lifecycle.

  `new_conversation?` (issue #262) is true only when the CALLING agent
  omitted `conversation_id` and the wrapper allocated a fresh one — the
  one case where an unknown id is legitimate. When it is false (the
  agent supplied this id explicitly) and no entry exists for it, the
  send is rejected as `{:error, :unknown_conversation_id}` instead of
  silently opening a new, context-less thread under a mistyped or
  stale id; see the moduledoc. Defaults to `true` so every pre-#262
  caller — every test in this suite included — keeps its original
  "unknown id always starts fresh" behaviour unless it opts in.
  `server` sits before this default (not after): both are optional
  trailing positional args, and Elixir resolves a partial positional
  call left-to-right, so appending `new_conversation?` after `server`
  is what lets every existing call — 6-arg default-server callers and
  7-arg custom-server test callers alike — keep resolving exactly as it
  did before this param existed.
  """
  def record_message(
        conversation_id,
        from,
        to,
        body,
        turn_number,
        done?,
        server \\ __MODULE__,
        new_conversation? \\ true
      ) do
    GenServer.call(
      server,
      {:record, conversation_id, from, to, body, turn_number, done?, new_conversation?}
    )
  end

  @doc "Returns the current entry for inspection (test helper)."
  def get(conversation_id, server \\ __MODULE__) do
    GenServer.call(server, {:get, conversation_id})
  end

  @doc """
  Returns one read-only `agent_id => sorted peer agent_ids` index for every
  active conversation. Agents without a conversation are absent. Directory
  projection deliberately uses this single batch call rather than one call
  per peer, because `directory_request` is auto-allow.
  """
  def peer_index(server \\ __MODULE__) do
    GenServer.call(server, :peer_index)
  end

  @doc """
  Claims at most `limit` still-open conversations in which `agent_id` takes
  part and whose peers have not been told yet that this agent is
  unreachable, marks them as notified, and returns
  `{[{conversation_id, other_participant_ids}], unclaimed_count}`. The
  wrapper channel calls it on disconnect (protocol-inter-agent
  「応答不能エラーの通知」, issue #131).

  Claiming — rather than plain listing — is what keeps a crash-looping or
  flapping wrapper from re-injecting the same notice into its peers on
  every reconnect cycle: the mark is only released when `agent_id` sends
  another message in that conversation (`record_message/7`), i.e. when it
  has demonstrably come back. `limit` bounds the per-disconnect fan-out;
  the leftover count is returned so the caller can log what it dropped.
  Counters (turns / tokens / wallclock) are never touched here — a
  server-derived notice is not a conversation turn.
  """
  def claim_unreachable_targets(agent_id, limit, server \\ __MODULE__) do
    GenServer.call(server, {:claim_unreachable, agent_id, limit})
  end

  @impl true
  def init({_name, clock, on_auto_closed}) do
    schedule_gc()

    {:ok,
     %{conversations: %{}, limits: load_limits(), clock: clock, on_auto_closed: on_auto_closed}}
  end

  defp load_limits do
    cfg = Application.get_env(:kaoiro_server, :inter_agent, [])

    %{
      max_turns: Keyword.get(cfg, :max_turns, 20),
      max_tokens: Keyword.get(cfg, :max_tokens, 100_000),
      max_concurrent_agents: Keyword.get(cfg, :max_concurrent_agents, 2),
      # GC-only TTLs (issue #221) — NOT hard limits: neither one rejects a
      # message or synthesizes an escalate-to-user envelope. Split from the
      # former single max_wallclock_ms because the two govern different
      # transitions on different base timestamps (see moduledoc).
      open_conversation_ttl_ms: Keyword.get(cfg, :open_conversation_ttl_ms, 86_400_000),
      tombstone_ttl_ms: Keyword.get(cfg, :tombstone_ttl_ms, 86_400_000),
      # Global cap (protocol-inter-agent memory-DoS defense). 10k entries at
      # ~few hundred bytes apiece bounds worst-case memory regardless of how
      # many wrappers spam fresh conversation_ids.
      max_conversations: Keyword.get(cfg, :max_conversations, 10_000)
    }
  end

  @impl true
  def handle_call(
        {:record, cid, from, to, body, turn_number, done?, new_conversation?},
        _from,
        state
      ) do
    now = state.clock.()
    limits = state.limits
    existing = Map.get(state.conversations, cid)

    cond do
      # issue #177: a CLOSED tombstone accepts no further messages at all —
      # checked before the participants check so a reused/delayed message
      # from ANY sender gets the same conversation_closed answer, not a
      # misleading participants_mismatch.
      existing != nil and existing.status == :closed ->
        {:reply, {:error, :conversation_closed}, state}

      # Cross-conversation pollution defense: an existing OPEN entry only
      # accepts messages from its declared participants. A third party
      # reusing a known cid would otherwise grow the agents set past
      # max_concurrent_agents and wipe the legitimate counters via the
      # :exceeded branch.
      existing != nil and not MapSet.subset?(MapSet.new([from, to]), existing.agents) ->
        {:reply, {:error, :participants_mismatch}, state}

      # issue #177 review M1: a turn_number no greater than the highest
      # already recorded for this OPEN conversation is late, duplicate, or
      # out-of-order — reject before it can corrupt turns/tokens. Checked
      # after participants_mismatch (only meaningful once from/to are
      # confirmed legitimate) and before the brand-new-conversation cap
      # (existing is never nil here).
      existing != nil and turn_number <= existing.max_turn_number ->
        {:reply, {:error, :stale_turn}, state}

      # issue #262: an explicitly-named id (new_conversation? == false) with
      # no entry at all — open or tombstoned — is a transcription error, not
      # a new thread. Checked before the capacity cap below: a mistyped id
      # never should have consumed quota to begin with, so its rejection
      # reason must not depend on how full the tracker happens to be right
      # now. Never true for new_conversation? == true: a wrapper-allocated
      # fresh UUID is by construction unknown to this map, and that is the
      # ONE case where "unknown" is the expected, legitimate state.
      existing == nil and not new_conversation? ->
        {:reply, {:error, :unknown_conversation_id}, state}

      existing == nil and map_size(state.conversations) >= limits.max_conversations ->
        # Bound total in-flight conversations so a malicious wrapper streaming
        # fresh cids cannot grow the map without limit. Existing entries
        # (open or tombstoned) are unaffected.
        {:reply, {:error, :too_many_conversations}, state}

      true ->
        # `existing`, if present here, is guaranteed OPEN — the :closed case
        # already returned above.
        entry =
          existing ||
            %{
              status: :open,
              turns: 0,
              max_turn_number: 0,
              tokens: 0,
              started_at: now,
              agents: MapSet.new(),
              done_by: MapSet.new(),
              notified_unreachable: MapSet.new()
            }

        agents = entry.agents |> MapSet.put(from) |> MapSet.put(to)
        done_by = if done?, do: MapSet.put(entry.done_by, from), else: entry.done_by

        next = %{
          entry
          | turns: entry.turns + 1,
            max_turn_number: turn_number,
            tokens: entry.tokens + token_estimate(body),
            agents: agents,
            done_by: done_by,
            # `from` just spoke here, so any earlier "unreachable" mark for it
            # is stale: a later disconnect must notify its peers again.
            notified_unreachable: MapSet.delete(entry.notified_unreachable, from)
        }

        evaluate(state, cid, next, limits, now)
    end
  end

  def handle_call({:get, cid}, _from, state) do
    {:reply, Map.get(state.conversations, cid), state}
  end

  def handle_call(:peer_index, _from, state) do
    index =
      state.conversations
      # issue #177: a CLOSED tombstone is not an active conversation — it
      # must not appear as an "active peer" in the directory.
      |> Enum.filter(fn {_cid, entry} -> entry.status == :open end)
      |> Enum.reduce(%{}, fn {_cid, entry}, acc ->
        for agent_id <- entry.agents, peer_id <- entry.agents, peer_id != agent_id, reduce: acc do
          acc -> Map.update(acc, agent_id, MapSet.new([peer_id]), &MapSet.put(&1, peer_id))
        end
      end)
      |> Map.new(fn {agent_id, peers} -> {agent_id, peers |> MapSet.to_list() |> Enum.sort()} end)

    {:reply, index, state}
  end

  def handle_call({:claim_unreachable, agent_id, limit}, _from, state) do
    pending =
      for {cid, entry} <- state.conversations,
          # issue #177: a CLOSED tombstone has no `notified_unreachable` set
          # (dropped at close) and is not active — exclude it before the
          # field accesses below, and checked first so the comprehension's
          # short-circuit protects them.
          entry.status == :open,
          MapSet.member?(entry.agents, agent_id),
          not MapSet.member?(entry.notified_unreachable, agent_id) do
        {cid, entry.agents |> MapSet.delete(agent_id) |> MapSet.to_list()}
      end

    {claimed, unclaimed} = Enum.split(pending, limit)

    conversations =
      Enum.reduce(claimed, state.conversations, fn {cid, _peers}, acc ->
        Map.update!(acc, cid, fn entry ->
          %{entry | notified_unreachable: MapSet.put(entry.notified_unreachable, agent_id)}
        end)
      end)

    {:reply, {claimed, length(unclaimed)}, %{state | conversations: conversations}}
  end

  @impl true
  def handle_info(:gc, state) do
    schedule_gc()
    now = state.clock.()
    open_ttl = state.limits.open_conversation_ttl_ms
    tombstone_ttl = state.limits.tombstone_ttl_ms

    {conversations, tombstoned, dropped, auto_closed} =
      Enum.reduce(state.conversations, {%{}, 0, 0, []}, fn {cid, entry},
                                                           {acc, tomb, drop, closed} ->
        case gc_disposition(entry, now, open_ttl, tombstone_ttl) do
          :keep ->
            {Map.put(acc, cid, entry), tomb, drop, closed}

          {:tombstone, closed_entry} ->
            # issue #221 direction 2: only THIS transition (open_conversation_
            # ttl, a sweep-driven auto-close) needs peer propagation — a
            # hard-limit closure already notifies its participants from
            # `record_message/6`'s own return value (wrapper_channel.ex's
            # `preflight_inter_agent`), and `gc_disposition/4` never
            # produces any other tombstone reason.
            closed = [{cid, MapSet.to_list(closed_entry.agents), closed_entry.reason} | closed]
            {Map.put(acc, cid, closed_entry), tomb + 1, drop, closed}

          :drop ->
            {acc, tomb, drop, closed}
        end
      end)

    if tombstoned > 0 or dropped > 0 do
      Logger.debug(
        "conversation_states gc: tombstoned #{tombstoned} expired open entries, " <>
          "dropped #{dropped} expired tombstones"
      )
    end

    # Isolate the callback from this GenServer's own survival: it is the
    # ONLY point where this otherwise web-independent module's data reaches
    # web-layer code (issue #221 direction 2/D19 boundary — see
    # `:on_auto_closed`'s doc). An exception here (a bug in the delivery
    # side, not in anything this module owns) must not crash a singleton
    # GenServer holding every OTHER agent's still-open conversations too.
    #
    # `rescue` alone is not enough (issue #221 段階3 MF-2, ふじレビュー差し
    # 戻し): it only catches Elixir exceptions (`raise`), not `exit` — and
    # the callback's typical shape (IngressOrder.allocate/0,
    # AgentStates.upsert_ia/3) is a `GenServer.call/2` chain, where a
    # target process being down or timing out surfaces as `exit`, not an
    # exception. An uncaught `exit` here would propagate straight through
    # this `handle_info(:gc)` clause, crashing this GenServer BEFORE it
    # ever returns `{:noreply, %{state | conversations: conversations}}`
    # below — losing every OTHER agent's still-open conversation state
    # along with it, the exact blast radius `rescue` was meant to prevent.
    Enum.each(auto_closed, fn {cid, agent_ids, reason} ->
      try do
        state.on_auto_closed.(cid, agent_ids, reason)
      rescue
        e ->
          Logger.error(
            "conversation_states gc: on_auto_closed callback raised for " <>
              "#{cid}: #{Exception.format(:error, e, __STACKTRACE__)}"
          )
      catch
        :exit, exit_reason ->
          Logger.error(
            "conversation_states gc: on_auto_closed callback exited for " <>
              "#{cid}: #{inspect(exit_reason)}"
          )
      end
    end)

    {:noreply, %{state | conversations: conversations}}
  end

  # issue #177: the periodic sweep must not silently delete an open entry —
  # a delayed message reaching it afterwards would otherwise be treated as a
  # brand-new conversation instead of a stale one. Transition to an
  # :open_conversation_ttl tombstone instead (issue #221: memory-DoS defense
  # only, not a hard limit — see moduledoc); a genuinely expired tombstone
  # (its own `closed_at` TTL elapsed) is the only case still deleted
  # outright.
  defp gc_disposition(%{status: :closed, closed_at: closed_at}, now, _open_ttl, tombstone_ttl) do
    if now - closed_at > tombstone_ttl, do: :drop, else: :keep
  end

  defp gc_disposition(%{status: :open} = entry, now, open_ttl, _tombstone_ttl) do
    if now - entry.started_at > open_ttl do
      {:tombstone, close_entry(entry, :open_conversation_ttl, now)}
    else
      :keep
    end
  end

  defp evaluate(state, cid, next, limits, now) do
    cond do
      MapSet.size(next.agents) > limits.max_concurrent_agents ->
        {:reply, {:exceeded, :max_concurrent_agents},
         close(state, cid, next, :max_concurrent_agents, now)}

      next.turns > limits.max_turns ->
        {:reply, {:exceeded, :max_turns}, close(state, cid, next, :max_turns, now)}

      next.tokens > limits.max_tokens ->
        {:reply, {:exceeded, :max_tokens}, close(state, cid, next, :max_tokens, now)}

      # Spec MUST: every participating agent must have signalled done=true
      # for the conversation to complete. Close the entry only then.
      MapSet.size(next.done_by) > 0 and MapSet.subset?(next.agents, next.done_by) ->
        {:reply, :both_done, close(state, cid, next, :both_done, now)}

      true ->
        {:reply, :ok, %{state | conversations: Map.put(state.conversations, cid, next)}}
    end
  end

  # issue #177: transitions the OPEN entry in place to a CLOSED tombstone
  # (moduledoc) rather than deleting it, so a late message on the same cid
  # gets :conversation_closed instead of silently starting a new
  # conversation.
  defp close(state, cid, next, reason, now) do
    %{state | conversations: Map.put(state.conversations, cid, close_entry(next, reason, now))}
  end

  defp close_entry(entry, reason, now) do
    %{
      status: :closed,
      reason: reason,
      closed_at: now,
      agents: entry.agents,
      last_turn: entry.turns
    }
  end

  defp schedule_gc do
    Process.send_after(self(), :gc, @gc_interval_ms)
  end

  # Coarse token estimate — divide body bytes by 3 (protocol-inter-agent
  # spec). Good enough to prevent runaway, not a billing-grade count.
  defp token_estimate(body) when is_binary(body) do
    div(byte_size(body), 3) + 1
  end

  defp token_estimate(_), do: 1
end
