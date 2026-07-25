defmodule KaoiroServer.ConversationStates do
  @moduledoc """
  Per-conversation tracker for inter-agent messaging (protocol-inter-agent
  spec, phase-8 Stage B). In-memory only — a conversation that lives across
  a server restart starts fresh (Phase 2 / ADR-0014 will address durability).

  For each `conversation_id` we keep the turn count, the running token
  approximation (`byte_size(body) ÷ 3` per message — protocol-inter-agent
  spec, intentionally coarse), the wallclock start time, the participating
  agent_id set, the set of agent_ids that have signalled `meta.done=true`
  so far, and the set already reported unreachable to their peers
  (`claim_unreachable_targets/3`, issue #131). `record_message/5`
  increments the counters and returns:

    * `:ok` — within limits, conversation still open.
    * `:both_done` — within limits, this message carried `done=true` and the
      counterpart side had already done so. The entry is removed atomically;
      the caller relays the envelope but performs no further close.
    * `{:exceeded, reason}` — hard-limit overshoot (`:max_turns` / `:max_tokens`
      / `:max_wallclock` / `:max_concurrent_agents`). The entry is removed.
    * `{:error, :participants_mismatch}` — the sender/recipient pair is not
      part of an existing entry under that `conversation_id` (cross-conversation
      pollution defense, protocol-inter-agent threat-model).
    * `{:error, :too_many_conversations}` — the global `max_conversations` cap
      blocked a brand-new conversation; existing entries are unaffected.

  A periodic sweep (`:gc` self-message) drops entries whose wallclock has
  expired even without further messages — without it, a stale entry would
  pin memory until the next message under the same id.
  """

  use GenServer

  require Logger

  # Sweep frequency for the wallclock-based GC of stale entries
  # (protocol-inter-agent memory-DoS defense). Set well below max_wallclock_ms
  # so an expired conversation never lingers more than the sweep interval.
  @gc_interval_ms 60_000

  @doc "Starts the tracker; tests can register an isolated instance via `:name`."
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, name, name: name)
  end

  @doc """
  Records a new message in `conversation_id` from `from` to `to`, weighing
  the body for token accounting. `done?` is `payload.meta.done` for this
  message — `true` records the sender as having signalled done; the entry
  only closes once every participating agent has done so (spec MUST: both
  owner-side done で対話完了).
  """
  def record_message(conversation_id, from, to, body, done?, server \\ __MODULE__) do
    GenServer.call(server, {:record, conversation_id, from, to, body, done?})
  end

  @doc "Returns the current entry for inspection (test helper)."
  def get(conversation_id, server \\ __MODULE__) do
    GenServer.call(server, {:get, conversation_id})
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
  another message in that conversation (`record_message/6`), i.e. when it
  has demonstrably come back. `limit` bounds the per-disconnect fan-out;
  the leftover count is returned so the caller can log what it dropped.
  Counters (turns / tokens / wallclock) are never touched here — a
  server-derived notice is not a conversation turn.
  """
  def claim_unreachable_targets(agent_id, limit, server \\ __MODULE__) do
    GenServer.call(server, {:claim_unreachable, agent_id, limit})
  end

  @impl true
  def init(_name) do
    schedule_gc()
    {:ok, %{conversations: %{}, limits: load_limits()}}
  end

  defp load_limits do
    cfg = Application.get_env(:kaoiro_server, :inter_agent, [])

    %{
      max_turns: Keyword.get(cfg, :max_turns, 20),
      max_tokens: Keyword.get(cfg, :max_tokens, 100_000),
      max_wallclock_ms: Keyword.get(cfg, :max_wallclock_ms, 600_000),
      max_concurrent_agents: Keyword.get(cfg, :max_concurrent_agents, 2),
      # Global cap (protocol-inter-agent memory-DoS defense). 10k entries at
      # ~few hundred bytes apiece bounds worst-case memory regardless of how
      # many wrappers spam fresh conversation_ids.
      max_conversations: Keyword.get(cfg, :max_conversations, 10_000)
    }
  end

  @impl true
  def handle_call({:record, cid, from, to, body, done?}, _from, state) do
    now = System.monotonic_time(:millisecond)
    limits = state.limits
    existing = Map.get(state.conversations, cid)

    cond do
      # Cross-conversation pollution defense: an existing entry only accepts
      # messages from its declared participants. A third party reusing a known
      # cid would otherwise grow the agents set past max_concurrent_agents
      # and wipe the legitimate counters via the :exceeded branch.
      existing != nil and not MapSet.subset?(MapSet.new([from, to]), existing.agents) ->
        {:reply, {:error, :participants_mismatch}, state}

      existing == nil and map_size(state.conversations) >= limits.max_conversations ->
        # Bound total in-flight conversations so a malicious wrapper streaming
        # fresh cids cannot grow the map without limit. Existing entries are
        # unaffected.
        {:reply, {:error, :too_many_conversations}, state}

      true ->
        entry =
          existing ||
            %{
              turns: 0,
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

  def handle_call({:claim_unreachable, agent_id, limit}, _from, state) do
    pending =
      for {cid, entry} <- state.conversations,
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
    now = System.monotonic_time(:millisecond)
    cap = state.limits.max_wallclock_ms

    pruned =
      state.conversations
      |> Enum.reject(fn {_cid, entry} -> now - entry.started_at > cap end)
      |> Map.new()

    dropped = map_size(state.conversations) - map_size(pruned)

    if dropped > 0 do
      Logger.debug("conversation_states gc: dropped #{dropped} expired entries")
    end

    {:noreply, %{state | conversations: pruned}}
  end

  defp evaluate(state, cid, next, limits, now) do
    cond do
      MapSet.size(next.agents) > limits.max_concurrent_agents ->
        {:reply, {:exceeded, :max_concurrent_agents}, drop(state, cid)}

      next.turns > limits.max_turns ->
        {:reply, {:exceeded, :max_turns}, drop(state, cid)}

      next.tokens > limits.max_tokens ->
        {:reply, {:exceeded, :max_tokens}, drop(state, cid)}

      now - next.started_at > limits.max_wallclock_ms ->
        {:reply, {:exceeded, :max_wallclock}, drop(state, cid)}

      # Spec MUST: every participating agent must have signalled done=true
      # for the conversation to complete. Drop the entry only then.
      MapSet.size(next.done_by) > 0 and MapSet.subset?(next.agents, next.done_by) ->
        {:reply, :both_done, drop(state, cid)}

      true ->
        {:reply, :ok, %{state | conversations: Map.put(state.conversations, cid, next)}}
    end
  end

  defp drop(state, cid) do
    %{state | conversations: Map.delete(state.conversations, cid)}
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
