defmodule KaoiroServer.ConversationStatesTest do
  # Per-conversation hard limits + participant guard + GC for inter-agent
  # messaging (protocol-inter-agent spec, phase-8 Stage B). Each test boots
  # its own isolated GenServer instance via `:name` so config overrides do
  # not leak.
  use ExUnit.Case, async: true

  alias KaoiroServer.ConversationStates

  defp start_tracker(name, limits \\ []) do
    Application.put_env(:kaoiro_server, :inter_agent, limits)
    on_exit(fn -> Application.delete_env(:kaoiro_server, :inter_agent) end)
    start_supervised!({ConversationStates, name: name})
    name
  end

  # issue #177 review nit2 (AGENTS.md「Avoid Process.sleep/1 in tests」):
  # injects a deterministic clock (an Agent holding an integer ms value)
  # instead of sleeping real wallclock time to make GC / TTL behaviour
  # observable. `advance_clock/2` moves it forward; `sync_gc/1` forces a
  # synchronous `:gc` round-trip (`:sys.get_state/1`) instead of a sleep.
  # `extra_opts` (issue #221 direction 2) lets a test inject `:on_auto_closed`
  # alongside the clock; existing callers passing none get identical
  # behaviour to before (default no-op callback).
  defp start_tracker_with_clock(name, limits, extra_opts \\ []) do
    Application.put_env(:kaoiro_server, :inter_agent, limits)
    on_exit(fn -> Application.delete_env(:kaoiro_server, :inter_agent) end)
    {:ok, clock_agent} = Agent.start_link(fn -> 0 end)
    clock = fn -> Agent.get(clock_agent, & &1) end
    start_supervised!({ConversationStates, [name: name, clock: clock] ++ extra_opts})
    {name, clock_agent}
  end

  defp advance_clock(clock_agent, ms) do
    Agent.update(clock_agent, &(&1 + ms))
  end

  defp sync_gc(pid) do
    send(pid, :gc)
    :sys.get_state(pid)
  end

  test "通常の record_message は :ok を返しエントリを保持する" do
    name = start_tracker(:cs_basic)

    assert :ok =
             ConversationStates.record_message("c1", "a", "b", "hello", 1, false, name)

    assert %{turns: 1, tokens: tokens, agents: agents, done_by: done_by} =
             ConversationStates.get("c1", name)

    assert MapSet.equal?(agents, MapSet.new(["a", "b"]))
    assert MapSet.size(done_by) == 0
    assert tokens > 0
  end

  test "peer_index は会話ごとの副作用なし batch snapshot を重複排除してソートする" do
    name = start_tracker(:cs_peer_index)
    assert :ok = ConversationStates.record_message("c1", "b", "a", "x", 1, false, name)
    assert :ok = ConversationStates.record_message("c2", "a", "c", "x", 1, false, name)

    assert %{"a" => ["b", "c"], "b" => ["a"], "c" => ["a"]} =
             ConversationStates.peer_index(name)

    # Read-only: the ordinary entry is still present and has the same turns.
    assert %{turns: 1} = ConversationStates.get("c1", name)
  end

  test "max_turns を超えると :exceeded :max_turns で tombstone 化する (#177)" do
    name = start_tracker(:cs_turns, max_turns: 2)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name)
    assert :ok = ConversationStates.record_message("c", "b", "a", "y", 2, false, name)

    assert {:exceeded, :max_turns} =
             ConversationStates.record_message("c", "a", "b", "z", 3, false, name)

    assert %{status: :closed, reason: :max_turns} = ConversationStates.get("c", name)
  end

  test "max_tokens を超えると :exceeded :max_tokens で tombstone 化する (#177)" do
    name = start_tracker(:cs_tokens, max_tokens: 10)
    # body の token は byte_size/3 + 1 で粗近似(spec)。20 バイトで >10。
    body = String.duplicate("x", 30)

    assert {:exceeded, :max_tokens} =
             ConversationStates.record_message("c", "a", "b", body, 1, false, name)

    assert %{status: :closed, reason: :max_tokens} = ConversationStates.get("c", name)
  end

  test "max_concurrent_agents を超えると :exceeded を返す" do
    # 既存エントリの participants と一致しない new agent からの送信は
    # participants_mismatch で蹴られるため、agents 過剰判定単独を確かめるには
    # 1 メッセージ目から 3 名(from=a, to=b)→ to=c に切替えるのではなく、
    # max_concurrent_agents を 1 に絞って最初の一発で agents.size > 1 を発生
    # させる(participants_mismatch 経路を通らない安全な再現)。
    name = start_tracker(:cs_agents, max_concurrent_agents: 1)

    assert {:exceeded, :max_concurrent_agents} =
             ConversationStates.record_message("c", "a", "b", "x", 1, false, name)
  end

  test "両 owner-side が done=true を出すと :both_done を返し tombstone 化する (#177)" do
    name = start_tracker(:cs_done)
    # 1 メッセージ目: a→b done=false (a だけが参加。done_by 空)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name)
    # 2 メッセージ目: a→b done=true (a が done に入る。b はまだ。:ok)
    assert :ok = ConversationStates.record_message("c", "a", "b", "y", 2, true, name)
    assert %{done_by: done_by} = ConversationStates.get("c", name)
    assert MapSet.equal?(done_by, MapSet.new(["a"]))

    # 3 メッセージ目: b→a done=true (b も done。両側揃って :both_done で tombstone 化)
    assert :both_done =
             ConversationStates.record_message("c", "b", "a", "z", 3, true, name)

    assert %{status: :closed, reason: :both_done} = ConversationStates.get("c", name)
  end

  test "closed な conversation への同一 cid 送信は :conversation_closed で拒否する (#177)" do
    name = start_tracker(:cs_closed_reject)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, true, name)
    assert :both_done = ConversationStates.record_message("c", "b", "a", "y", 2, true, name)

    assert {:error, :conversation_closed} =
             ConversationStates.record_message("c", "a", "b", "z", 3, false, name)

    # 拒否された送信は tombstone を書き換えない。
    assert %{status: :closed, reason: :both_done} = ConversationStates.get("c", name)
  end

  test "closed な conversation は第三者の送信にも participants_mismatch でなく " <>
         "conversation_closed を返す (#177)" do
    name = start_tracker(:cs_closed_third_party)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, true, name)
    assert :both_done = ConversationStates.record_message("c", "b", "a", "y", 2, true, name)

    assert {:error, :conversation_closed} =
             ConversationStates.record_message("c", "z", "b", "evil", 1, false, name)
  end

  test "closed な tombstone も max_conversations の上限に数える (#177)" do
    name = start_tracker(:cs_cap_tombstone, max_conversations: 1)
    assert :ok = ConversationStates.record_message("c1", "a", "b", "x", 1, true, name)
    assert :both_done = ConversationStates.record_message("c1", "b", "a", "y", 2, true, name)

    assert {:error, :too_many_conversations} =
             ConversationStates.record_message("c2", "a", "b", "z", 1, false, name)
  end

  test "peer_index は closed な conversation を除外する (#177)" do
    name = start_tracker(:cs_peer_index_closed)
    assert :ok = ConversationStates.record_message("c1", "a", "b", "x", 1, true, name)
    assert :both_done = ConversationStates.record_message("c1", "b", "a", "y", 2, true, name)
    assert :ok = ConversationStates.record_message("c2", "a", "c", "z", 1, false, name)

    assert %{"a" => ["c"], "c" => ["a"]} = ConversationStates.peer_index(name)
  end

  test "periodic GC は期限切れ open entry を :open_conversation_ttl tombstone へ遷移させる (#177, #221)" do
    {name, clock} = start_tracker_with_clock(:cs_gc_tombstone, open_conversation_ttl_ms: 1)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name)
    advance_clock(clock, 5)

    pid = Process.whereis(name)
    sync_gc(pid)

    assert %{status: :closed, reason: :open_conversation_ttl} = ConversationStates.get("c", name)
    # A tombstoned entry still refuses further sends, same as any other close
    # reason.
    assert {:error, :conversation_closed} =
             ConversationStates.record_message("c", "a", "b", "y", 2, false, name)
  end

  test "tombstone は tombstone_ttl_ms 経過後に GC で削除され CID を再利用できる (#177, #221)" do
    {name, clock} = start_tracker_with_clock(:cs_gc_ttl, tombstone_ttl_ms: 1)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, true, name)
    assert :both_done = ConversationStates.record_message("c", "b", "a", "y", 2, true, name)
    pid = Process.whereis(name)

    assert %{status: :closed} = ConversationStates.get("c", name)

    advance_clock(clock, 5)
    sync_gc(pid)

    assert ConversationStates.get("c", name) == nil

    # CID 再利用: closed_at からの TTL が過ぎれば新規会話として受理される。
    assert :ok = ConversationStates.record_message("c", "a", "b", "z", 1, false, name)
  end

  test "片側だけ done では :ok のまま (両 owner-side 同意で初めて完了)" do
    name = start_tracker(:cs_one_done)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, true, name)
    # a が done=true、ただし b はまだ。:ok 継続。エントリ生存。
    assert %{done_by: done_by} = ConversationStates.get("c", name)
    assert MapSet.equal?(done_by, MapSet.new(["a"]))
  end

  test "既存 conversation_id を第三者が再利用しようとすると participants_mismatch" do
    name = start_tracker(:cs_pollution)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name)

    # 攻撃者 c が同じ cid を流用。既存 entry.agents={a,b} に c は含まれない。
    assert {:error, :participants_mismatch} =
             ConversationStates.record_message("c", "c", "b", "evil", 2, false, name)

    # 正規参加者の entry は無傷。
    assert %{turns: 1} = ConversationStates.get("c", name)
  end

  test "max_conversations を超える新規 cid は :too_many_conversations で拒否" do
    name = start_tracker(:cs_cap, max_conversations: 2)
    assert :ok = ConversationStates.record_message("c1", "a", "b", "x", 1, false, name)
    assert :ok = ConversationStates.record_message("c2", "a", "b", "x", 1, false, name)

    assert {:error, :too_many_conversations} =
             ConversationStates.record_message("c3", "a", "b", "x", 1, false, name)

    # 既存エントリへの追加メッセージは通る (cap は新規のみ)
    assert :ok = ConversationStates.record_message("c1", "a", "b", "y", 2, false, name)
  end

  describe "unknown_conversation_id (issue #262)" do
    test "new_conversation?=false かつ未知の cid は unknown_conversation_id で拒否され、" <>
           "エントリを作らない" do
      name = start_tracker(:cs_unknown_cid)

      assert {:error, :unknown_conversation_id} =
               ConversationStates.record_message("c", "a", "b", "typo", 1, false, name, false)

      # 拒否された cid はエントリを一切残さない — max_conversations 消費も無い
      # ことの直接的な証拠。
      assert ConversationStates.get("c", name) == nil
    end

    test "new_conversation? の既定値は true (旧呼び出しは影響を受けない)" do
      name = start_tracker(:cs_unknown_cid_default)
      # 8 引数目 (new_conversation?) を省略 — #262 以前の全呼び出しと同じ形。
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name)
      assert %{turns: 1} = ConversationStates.get("c", name)
    end

    test "closed な conversation への明示 id 送信は unknown_conversation_id ではなく " <>
           "conversation_closed のまま (#177 との整合)" do
      name = start_tracker(:cs_unknown_cid_vs_closed)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, true, name, true)

      assert :both_done =
               ConversationStates.record_message("c", "b", "a", "y", 2, true, name, true)

      # tombstone は existing != nil なので #262 の新チェックに触れる前に
      # :conversation_closed で弾かれる — new_conversation?: false でも同じ。
      assert {:error, :conversation_closed} =
               ConversationStates.record_message("c", "a", "b", "z", 3, false, name, false)
    end

    test "第三者の再利用は new_conversation?=false でも unknown_conversation_id ではなく " <>
           "participants_mismatch のまま" do
      name = start_tracker(:cs_unknown_cid_vs_pollution)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name, true)

      assert {:error, :participants_mismatch} =
               ConversationStates.record_message("c", "z", "b", "evil", 2, false, name, false)
    end

    test "stale_turn は new_conversation?=false でも unknown_conversation_id ではなく " <>
           "stale_turn のまま" do
      name = start_tracker(:cs_unknown_cid_vs_stale)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name, true)
      assert :ok = ConversationStates.record_message("c", "b", "a", "y", 2, false, name, false)

      assert {:error, :stale_turn} =
               ConversationStates.record_message("c", "a", "b", "z", 2, false, name, false)
    end

    test "既知の cid への明示送信 (new_conversation?=false) は通常どおり継続できる" do
      name = start_tracker(:cs_unknown_cid_reply)
      # 発起側: conversation_id 省略相当 (wrapper 採番) -> new_conversation?=true
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name, true)

      # 応答側: 相手から受け取った id を明示指定 -> new_conversation?=false だが
      # 既に存在するので #262 のチェックには一切触れず、通常どおり :ok。
      assert :ok = ConversationStates.record_message("c", "b", "a", "y", 2, false, name, false)
      assert %{turns: 2} = ConversationStates.get("c", name)
    end
  end

  describe "turn_number バリデーション (#177 review M1)" do
    test "既知の max_turn_number 以下 (重複・遅延) は :stale_turn で拒否し counters を進めない" do
      name = start_tracker(:cs_stale_turn)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name)
      assert :ok = ConversationStates.record_message("c", "b", "a", "y", 2, false, name)

      # 重複 (直前と同じ turn_number)。
      assert {:error, :stale_turn} =
               ConversationStates.record_message("c", "a", "b", "dup", 2, false, name)

      # 遅延到着 (既知の最大値より低い)。
      assert {:error, :stale_turn} =
               ConversationStates.record_message("c", "b", "a", "late", 1, false, name)

      # 拒否は turns / max_turn_number を進めない。
      assert %{turns: 2, max_turn_number: 2} = ConversationStates.get("c", name)

      # 新しい turn_number は通常どおり受理される。
      assert :ok = ConversationStates.record_message("c", "a", "b", "z", 3, false, name)
      assert %{turns: 3, max_turn_number: 3} = ConversationStates.get("c", name)
    end

    test "brand-new conversation の初回は max_turn_number の制約を受けない" do
      name = start_tracker(:cs_stale_turn_fresh)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 5, false, name)
      assert %{max_turn_number: 5} = ConversationStates.get("c", name)
    end
  end

  describe "hard limit 3 種 x tombstone lifecycle 全経路 (#177 review S1, #221)" do
    test "max_turns: tombstone -> conversation_closed -> TTL 後に CID 再利用" do
      {name, clock} =
        start_tracker_with_clock(:cs_lifecycle_turns, max_turns: 1, tombstone_ttl_ms: 1_000)

      pid = Process.whereis(name)

      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name)

      assert {:exceeded, :max_turns} =
               ConversationStates.record_message("c", "b", "a", "y", 2, false, name)

      assert %{status: :closed, reason: :max_turns} = ConversationStates.get("c", name)

      assert {:error, :conversation_closed} =
               ConversationStates.record_message("c", "a", "b", "z", 3, false, name)

      advance_clock(clock, 1_001)
      sync_gc(pid)
      assert ConversationStates.get("c", name) == nil

      assert :ok = ConversationStates.record_message("c", "a", "b", "fresh", 1, false, name)
    end

    test "max_tokens: tombstone -> conversation_closed -> TTL 後に CID 再利用" do
      {name, clock} =
        start_tracker_with_clock(:cs_lifecycle_tokens, max_tokens: 10, tombstone_ttl_ms: 1_000)

      pid = Process.whereis(name)
      body = String.duplicate("x", 30)

      assert {:exceeded, :max_tokens} =
               ConversationStates.record_message("c", "a", "b", body, 1, false, name)

      assert %{status: :closed, reason: :max_tokens} = ConversationStates.get("c", name)

      assert {:error, :conversation_closed} =
               ConversationStates.record_message("c", "a", "b", "z", 2, false, name)

      advance_clock(clock, 1_001)
      sync_gc(pid)
      assert ConversationStates.get("c", name) == nil

      assert :ok = ConversationStates.record_message("c", "a", "b", "fresh", 1, false, name)
    end

    test "max_concurrent_agents: tombstone -> conversation_closed -> TTL 後に CID 再利用" do
      {name, clock} =
        start_tracker_with_clock(:cs_lifecycle_agents,
          max_concurrent_agents: 1,
          tombstone_ttl_ms: 1_000
        )

      pid = Process.whereis(name)

      assert {:exceeded, :max_concurrent_agents} =
               ConversationStates.record_message("c", "a", "b", "x", 1, false, name)

      assert %{status: :closed, reason: :max_concurrent_agents} =
               ConversationStates.get("c", name)

      assert {:error, :conversation_closed} =
               ConversationStates.record_message("c", "a", "b", "z", 2, false, name)

      advance_clock(clock, 1_001)
      sync_gc(pid)
      assert ConversationStates.get("c", name) == nil

      # 再利用後も同じ limit がまだ効いているので、CID は「新規」として
      # 受理された上でまた同じ理由で tombstone 化する (拒否ではなく新規受理
      # であることの確認が目的で、以後の挙動は limit 次第)。
      assert {:exceeded, :max_concurrent_agents} =
               ConversationStates.record_message("c", "a", "b", "fresh", 1, false, name)
    end
  end

  describe "open_conversation_ttl (GC-only, not a hard limit, #221)" do
    test "GC tombstone -> conversation_closed -> tombstone TTL 後に CID 再利用" do
      # Two independent TTLs chained end to end: open_conversation_ttl_ms
      # transitions the stale OPEN entry to a tombstone (no :exceeded reply —
      # this is a sweep-driven transition, not a record_message/6 result),
      # then tombstone_ttl_ms deletes the tombstone so the id becomes fresh
      # again — unlike the hard-limit reasons above, there is no
      # {:exceeded, _} reply to assert on this path.
      {name, clock} =
        start_tracker_with_clock(:cs_lifecycle_open_ttl,
          open_conversation_ttl_ms: 100,
          tombstone_ttl_ms: 100
        )

      pid = Process.whereis(name)

      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name)
      advance_clock(clock, 101)
      sync_gc(pid)

      assert %{status: :closed, reason: :open_conversation_ttl} =
               ConversationStates.get("c", name)

      assert {:error, :conversation_closed} =
               ConversationStates.record_message("c", "a", "b", "z", 2, false, name)

      advance_clock(clock, 101)
      sync_gc(pid)
      assert ConversationStates.get("c", name) == nil

      assert :ok = ConversationStates.record_message("c", "a", "b", "fresh", 1, false, name)
    end
  end

  describe "on_auto_closed callback (issue #221 direction 2)" do
    defp capturing_callback do
      {:ok, notifier} = Agent.start_link(fn -> [] end)

      callback = fn cid, agent_ids, reason ->
        Agent.update(notifier, &[{cid, agent_ids, reason} | &1])
      end

      {notifier, callback}
    end

    test "open_conversation_ttl での GC 遷移で cid・参加者・reason を渡し1回だけ呼ばれる" do
      {notifier, on_auto_closed} = capturing_callback()

      {name, clock} =
        start_tracker_with_clock(:cs_on_auto_closed, [open_conversation_ttl_ms: 1],
          on_auto_closed: on_auto_closed
        )

      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name)
      advance_clock(clock, 5)
      sync_gc(Process.whereis(name))

      assert [{"c", agent_ids, :open_conversation_ttl}] = Agent.get(notifier, & &1)
      assert Enum.sort(agent_ids) == ["a", "b"]
    end

    test "hard limit closure (max_turns 等) では呼ばれない (record_message の戻り値経路が別途通知する)" do
      {notifier, on_auto_closed} = capturing_callback()

      {name, _clock} =
        start_tracker_with_clock(:cs_on_auto_closed_hardlimit, [max_turns: 1],
          on_auto_closed: on_auto_closed
        )

      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name)

      assert {:exceeded, :max_turns} =
               ConversationStates.record_message("c", "b", "a", "y", 2, false, name)

      assert Agent.get(notifier, & &1) == []
    end

    test "both_done closure では呼ばれない (両側合意は既に自明で通知不要)" do
      {notifier, on_auto_closed} = capturing_callback()

      {name, _clock} =
        start_tracker_with_clock(:cs_on_auto_closed_bothdone, [], on_auto_closed: on_auto_closed)

      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, true, name)
      assert :both_done = ConversationStates.record_message("c", "b", "a", "y", 2, true, name)

      assert Agent.get(notifier, & &1) == []
    end

    test "callback が例外を投げても GenServer は生存し tombstone 遷移自体は完了する" do
      on_auto_closed = fn _cid, _agent_ids, _reason -> raise "boom" end

      {name, clock} =
        start_tracker_with_clock(:cs_on_auto_closed_raises, [open_conversation_ttl_ms: 1],
          on_auto_closed: on_auto_closed
        )

      pid = Process.whereis(name)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name)
      advance_clock(clock, 5)
      sync_gc(pid)

      assert Process.alive?(pid)

      assert %{status: :closed, reason: :open_conversation_ttl} =
               ConversationStates.get("c", name)
    end

    test "callback が exit しても GenServer は生存し tombstone 遷移自体は完了し他の open entry も保持される (issue #221 段階3 MF-2, ふじレビュー差し戻し)" do
      # `rescue` は Elixir 例外 (raise) のみを捕捉し `exit` を素通りする。
      # on_auto_closed の典型的な実装 (IngressOrder.allocate/0,
      # AgentStates.upsert_ia/3) は GenServer.call/2 経由なので、相手プロセス
      # の不在/timeout は exception ではなく exit として現れる — それを
      # exit/1 で直接模す。
      on_auto_closed = fn _cid, _agent_ids, _reason -> exit(:delivery_down) end

      {name, clock} =
        start_tracker_with_clock(:cs_on_auto_closed_exits, [open_conversation_ttl_ms: 1],
          on_auto_closed: on_auto_closed
        )

      pid = Process.whereis(name)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name)

      # TTL に触れない別会話を、GC 実行時点の now と同時刻で追加する — 巻き
      # 添えの範囲 ((c) の検証対象) を確かめるため、"c" の tombstone 化と
      # 同じ GC ラウンドに同居させつつ、この会話自体は開いたまま残る。
      advance_clock(clock, 5)
      assert :ok = ConversationStates.record_message("other", "x", "y", "z", 1, false, name)

      sync_gc(pid)

      # (a) GC 後も生存
      assert Process.alive?(pid)

      # (b) 対象は tombstone 化されている
      assert %{status: :closed, reason: :open_conversation_ttl} =
               ConversationStates.get("c", name)

      # (c) 巻き添えにならず他の open entry も保持されている (肝) —
      # singleton が全エージェントの会話状態を持つ以上、"c" の callback が
      # exit しても "other" の状態が失われないことが焦点。
      assert %{status: :open} = ConversationStates.get("other", name)
    end
  end

  test "claim_unreachable_targets は参加中の cid と自分以外の参加者を返す (#131)" do
    name = start_tracker(:cs_participants)
    assert :ok = ConversationStates.record_message("c1", "a", "b", "x", 1, false, name)
    assert :ok = ConversationStates.record_message("c2", "b", "c", "y", 1, false, name)

    assert {[{"c1", ["b"]}], 0} =
             ConversationStates.claim_unreachable_targets("a", 50, name)

    assert {[], 0} = ConversationStates.claim_unreachable_targets("zzz", 50, name)

    {claimed, 0} = ConversationStates.claim_unreachable_targets("b", 50, name)
    assert [{"c1", ["a"]}, {"c2", ["c"]}] = Enum.sort(claimed)
  end

  test "閉じた conversation は claim 対象にならない (#131)" do
    name = start_tracker(:cs_participants_closed)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, true, name)

    assert :both_done =
             ConversationStates.record_message("c", "b", "a", "y", 2, true, name)

    assert {[], 0} = ConversationStates.claim_unreachable_targets("a", 50, name)
  end

  test "同じ conversation を二重に claim しない (フラッピング抑止, #131)" do
    name = start_tracker(:cs_claim_once)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name)

    assert {[{"c", ["b"]}], 0} =
             ConversationStates.claim_unreachable_targets("a", 50, name)

    # 再接続しないまま切断を繰り返しても 2 度目は返らない。
    assert {[], 0} = ConversationStates.claim_unreachable_targets("a", 50, name)

    # 相手の発言だけでは解除しない (a はまだ戻ってきていない)。
    assert :ok = ConversationStates.record_message("c", "b", "a", "y", 2, false, name)
    assert {[], 0} = ConversationStates.claim_unreachable_targets("a", 50, name)

    # a 自身が同じ conversation で再び発言したら再武装する。
    assert :ok = ConversationStates.record_message("c", "a", "b", "z", 3, false, name)

    assert {[{"c", ["b"]}], 0} =
             ConversationStates.claim_unreachable_targets("a", 50, name)
  end

  test "claim は limit で打ち切り、未claim 件数を返す (#131)" do
    name = start_tracker(:cs_claim_limit)

    for n <- 1..3 do
      assert :ok = ConversationStates.record_message("c#{n}", "a", "b", "x", 1, false, name)
    end

    assert {claimed, 2} = ConversationStates.claim_unreachable_targets("a", 1, name)
    assert length(claimed) == 1

    # 打ち切られた分は notified 扱いにしないので次回 claim で拾える。
    assert {rest, 0} = ConversationStates.claim_unreachable_targets("a", 50, name)
    assert length(rest) == 2
  end

  test "limits は GenServer 起動時に Application env から取り込む" do
    name =
      start_tracker(:cs_envread,
        max_turns: 1,
        max_tokens: 100_000,
        max_concurrent_agents: 2,
        open_conversation_ttl_ms: 86_400_000,
        tombstone_ttl_ms: 86_400_000
      )

    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name)

    assert {:exceeded, :max_turns} =
             ConversationStates.record_message("c", "a", "b", "y", 2, false, name)
  end
end
