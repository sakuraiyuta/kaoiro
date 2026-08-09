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
  defp start_tracker_with_clock(name, limits) do
    Application.put_env(:kaoiro_server, :inter_agent, limits)
    on_exit(fn -> Application.delete_env(:kaoiro_server, :inter_agent) end)
    {:ok, clock_agent} = Agent.start_link(fn -> 0 end)
    clock = fn -> Agent.get(clock_agent, & &1) end
    start_supervised!({ConversationStates, name: name, clock: clock})
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

  test "periodic GC は期限切れ open entry を :max_wallclock tombstone へ遷移させる (#177)" do
    {name, clock} = start_tracker_with_clock(:cs_gc_tombstone, max_wallclock_ms: 1)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name)
    advance_clock(clock, 5)

    pid = Process.whereis(name)
    sync_gc(pid)

    assert %{status: :closed, reason: :max_wallclock} = ConversationStates.get("c", name)
    # A tombstoned entry still refuses further sends, same as any other close
    # reason.
    assert {:error, :conversation_closed} =
             ConversationStates.record_message("c", "a", "b", "y", 2, false, name)
  end

  test "tombstone は max_wallclock_ms 経過後に GC で削除され CID を再利用できる (#177)" do
    {name, clock} = start_tracker_with_clock(:cs_gc_ttl, max_wallclock_ms: 1)
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

  describe "hard limit 4 種 x tombstone lifecycle 全経路 (#177 review S1)" do
    test "max_turns: tombstone -> conversation_closed -> TTL 後に CID 再利用" do
      {name, clock} =
        start_tracker_with_clock(:cs_lifecycle_turns, max_turns: 1, max_wallclock_ms: 1_000)

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
        start_tracker_with_clock(:cs_lifecycle_tokens, max_tokens: 10, max_wallclock_ms: 1_000)

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
          max_wallclock_ms: 1_000
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

    test "max_wallclock: tombstone -> conversation_closed -> TTL 後に CID 再利用" do
      {name, clock} = start_tracker_with_clock(:cs_lifecycle_wallclock, max_wallclock_ms: 100)
      pid = Process.whereis(name)

      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name)
      advance_clock(clock, 101)

      assert {:exceeded, :max_wallclock} =
               ConversationStates.record_message("c", "b", "a", "y", 2, false, name)

      assert %{status: :closed, reason: :max_wallclock} = ConversationStates.get("c", name)

      assert {:error, :conversation_closed} =
               ConversationStates.record_message("c", "a", "b", "z", 3, false, name)

      advance_clock(clock, 101)
      sync_gc(pid)
      assert ConversationStates.get("c", name) == nil

      assert :ok = ConversationStates.record_message("c", "a", "b", "fresh", 1, false, name)
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
        max_wallclock_ms: 600_000,
        max_concurrent_agents: 2
      )

    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, name)

    assert {:exceeded, :max_turns} =
             ConversationStates.record_message("c", "a", "b", "y", 2, false, name)
  end
end
