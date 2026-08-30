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
             ConversationStates.record_message("c1", "a", "b", "hello", 1, false, true, name)

    assert %{turns: 1, tokens: tokens, agents: agents, done_by: done_by} =
             ConversationStates.get("c1", name)

    assert MapSet.equal?(agents, MapSet.new(["a", "b"]))
    assert MapSet.size(done_by) == 0
    assert tokens > 0
  end

  test "peer_index は会話ごとの副作用なし batch snapshot を重複排除してソートする" do
    name = start_tracker(:cs_peer_index)
    assert :ok = ConversationStates.record_message("c1", "b", "a", "x", 1, false, true, name)
    assert :ok = ConversationStates.record_message("c2", "a", "c", "x", 1, false, true, name)

    assert %{"a" => ["b", "c"], "b" => ["a"], "c" => ["a"]} =
             ConversationStates.peer_index(name)

    # Read-only: the ordinary entry is still present and has the same turns.
    assert %{turns: 1} = ConversationStates.get("c1", name)
  end

  test "max_turns を超えると :exceeded :max_turns で tombstone 化する (#177)" do
    name = start_tracker(:cs_turns, max_turns: 2)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)
    assert :ok = ConversationStates.record_message("c", "b", "a", "y", 2, false, true, name)

    assert {:exceeded, :max_turns} =
             ConversationStates.record_message("c", "a", "b", "z", 3, false, true, name)

    assert %{status: :closed, reason: :max_turns} = ConversationStates.get("c", name)
  end

  test "max_tokens を超えると :exceeded :max_tokens で tombstone 化する (#177)" do
    name = start_tracker(:cs_tokens, max_tokens: 10)
    # body の token は byte_size/3 + 1 で粗近似(spec)。20 バイトで >10。
    body = String.duplicate("x", 30)

    assert {:exceeded, :max_tokens} =
             ConversationStates.record_message("c", "a", "b", body, 1, false, true, name)

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
             ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)
  end

  test "両 owner-side が done=true を出すと :both_done を返し tombstone 化する (#177)" do
    name = start_tracker(:cs_done)
    # 1 メッセージ目: a→b done=false (a だけが参加。done_by 空)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)
    # 2 メッセージ目: a→b done=true (a が done に入る。b はまだ。:ok)
    assert :ok = ConversationStates.record_message("c", "a", "b", "y", 2, true, true, name)
    assert %{done_by: done_by} = ConversationStates.get("c", name)
    assert MapSet.equal?(done_by, MapSet.new(["a"]))

    # 3 メッセージ目: b→a done=true (b も done。両側揃って :both_done で tombstone 化)
    assert :both_done =
             ConversationStates.record_message("c", "b", "a", "z", 3, true, true, name)

    assert %{status: :closed, reason: :both_done} = ConversationStates.get("c", name)
  end

  test "closed な conversation への同一 cid 送信は :conversation_closed で拒否する (#177)" do
    name = start_tracker(:cs_closed_reject)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, true, true, name)
    assert :both_done = ConversationStates.record_message("c", "b", "a", "y", 2, true, true, name)

    assert {:error, :conversation_closed} =
             ConversationStates.record_message("c", "a", "b", "z", 3, false, true, name)

    # 拒否された送信は tombstone を書き換えない。
    assert %{status: :closed, reason: :both_done} = ConversationStates.get("c", name)
  end

  test "closed な conversation は第三者の送信にも participants_mismatch でなく " <>
         "conversation_closed を返す (#177)" do
    name = start_tracker(:cs_closed_third_party)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, true, true, name)
    assert :both_done = ConversationStates.record_message("c", "b", "a", "y", 2, true, true, name)

    assert {:error, :conversation_closed} =
             ConversationStates.record_message("c", "z", "b", "evil", 1, false, true, name)
  end

  test "closed な tombstone も max_conversations の上限に数える (#177)" do
    name = start_tracker(:cs_cap_tombstone, max_conversations: 1)
    assert :ok = ConversationStates.record_message("c1", "a", "b", "x", 1, true, true, name)

    assert :both_done =
             ConversationStates.record_message("c1", "b", "a", "y", 2, true, true, name)

    assert {:error, :too_many_conversations} =
             ConversationStates.record_message("c2", "a", "b", "z", 1, false, true, name)
  end

  test "peer_index は closed な conversation を除外する (#177)" do
    name = start_tracker(:cs_peer_index_closed)
    assert :ok = ConversationStates.record_message("c1", "a", "b", "x", 1, true, true, name)

    assert :both_done =
             ConversationStates.record_message("c1", "b", "a", "y", 2, true, true, name)

    assert :ok = ConversationStates.record_message("c2", "a", "c", "z", 1, false, true, name)

    assert %{"a" => ["c"], "c" => ["a"]} = ConversationStates.peer_index(name)
  end

  test "periodic GC は期限切れ open entry を :open_conversation_ttl tombstone へ遷移させる (#177, #221)" do
    {name, clock} = start_tracker_with_clock(:cs_gc_tombstone, open_conversation_ttl_ms: 1)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)
    advance_clock(clock, 5)

    pid = Process.whereis(name)
    sync_gc(pid)

    assert %{status: :closed, reason: :open_conversation_ttl} = ConversationStates.get("c", name)
    # A tombstoned entry still refuses further sends, same as any other close
    # reason.
    assert {:error, :conversation_closed} =
             ConversationStates.record_message("c", "a", "b", "y", 2, false, true, name)
  end

  test "tombstone は tombstone_ttl_ms 経過後に GC で削除され CID を再利用できる (#177, #221)" do
    {name, clock} = start_tracker_with_clock(:cs_gc_ttl, tombstone_ttl_ms: 1)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, true, true, name)
    assert :both_done = ConversationStates.record_message("c", "b", "a", "y", 2, true, true, name)
    pid = Process.whereis(name)

    assert %{status: :closed} = ConversationStates.get("c", name)

    advance_clock(clock, 5)
    sync_gc(pid)

    assert ConversationStates.get("c", name) == nil

    # CID 再利用: closed_at からの TTL が過ぎれば新規会話として受理される。
    assert :ok = ConversationStates.record_message("c", "a", "b", "z", 1, false, true, name)
  end

  test "片側だけ done では :ok のまま (両 owner-side 同意で初めて完了)" do
    name = start_tracker(:cs_one_done)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, true, true, name)
    # a が done=true、ただし b はまだ。:ok 継続。エントリ生存。
    assert %{done_by: done_by} = ConversationStates.get("c", name)
    assert MapSet.equal?(done_by, MapSet.new(["a"]))
  end

  test "既存 conversation_id を第三者が再利用しようとすると participants_mismatch" do
    name = start_tracker(:cs_pollution)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)

    # 攻撃者 c が同じ cid を流用。既存 entry.agents={a,b} に c は含まれない。
    assert {:error, :participants_mismatch} =
             ConversationStates.record_message("c", "c", "b", "evil", 2, false, true, name)

    # 正規参加者の entry は無傷。
    assert %{turns: 1} = ConversationStates.get("c", name)
  end

  test "max_conversations を超える新規 cid は :too_many_conversations で拒否" do
    name = start_tracker(:cs_cap, max_conversations: 2)
    assert :ok = ConversationStates.record_message("c1", "a", "b", "x", 1, false, true, name)
    assert :ok = ConversationStates.record_message("c2", "a", "b", "x", 1, false, true, name)

    assert {:error, :too_many_conversations} =
             ConversationStates.record_message("c3", "a", "b", "x", 1, false, true, name)

    # 既存エントリへの追加メッセージは通る (cap は新規のみ)
    assert :ok = ConversationStates.record_message("c1", "a", "b", "y", 2, false, true, name)
  end

  describe "unknown_conversation_id (issue #262)" do
    test "new_conversation?=false かつ未知の cid は unknown_conversation_id で拒否され、" <>
           "エントリを作らない" do
      name = start_tracker(:cs_unknown_cid)

      assert {:error, :unknown_conversation_id} =
               ConversationStates.record_message("c", "a", "b", "typo", 1, false, false, name)

      # 拒否された cid はエントリを一切残さない — max_conversations 消費も無い
      # ことの直接的な証拠。
      assert ConversationStates.get("c", name) == nil
    end

    test "closed な conversation への明示 id 送信は unknown_conversation_id ではなく " <>
           "conversation_closed のまま (#177 との整合)" do
      name = start_tracker(:cs_unknown_cid_vs_closed)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, true, true, name)

      assert :both_done =
               ConversationStates.record_message("c", "b", "a", "y", 2, true, true, name)

      # tombstone は existing != nil なので #262 の新チェックに触れる前に
      # :conversation_closed で弾かれる — new_conversation?: false でも同じ。
      assert {:error, :conversation_closed} =
               ConversationStates.record_message("c", "a", "b", "z", 3, false, false, name)
    end

    test "第三者の再利用は new_conversation?=false でも unknown_conversation_id ではなく " <>
           "participants_mismatch のまま" do
      name = start_tracker(:cs_unknown_cid_vs_pollution)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)

      assert {:error, :participants_mismatch} =
               ConversationStates.record_message("c", "z", "b", "evil", 2, false, false, name)
    end

    test "stale_turn は new_conversation?=false でも unknown_conversation_id ではなく " <>
           "stale_turn のまま" do
      name = start_tracker(:cs_unknown_cid_vs_stale)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)
      assert :ok = ConversationStates.record_message("c", "b", "a", "y", 2, false, false, name)

      assert {:error, :stale_turn} =
               ConversationStates.record_message("c", "a", "b", "z", 2, false, false, name)
    end

    test "既知の cid への明示送信 (new_conversation?=false) は通常どおり継続できる" do
      name = start_tracker(:cs_unknown_cid_reply)
      # 発起側: conversation_id 省略相当 (wrapper 採番) -> new_conversation?=true
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)

      # 応答側: 相手から受け取った id を明示指定 -> new_conversation?=false だが
      # 既に存在するので #262 のチェックには一切触れず、通常どおり :ok。
      assert :ok = ConversationStates.record_message("c", "b", "a", "y", 2, false, false, name)
      assert %{turns: 2} = ConversationStates.get("c", name)
    end

    test "new_conversation? が bool でなければ FunctionClauseError で即クラッシュする " <>
           "(レビュー、クロエ再測定 — is_boolean/1 ガードの pin)" do
      # #262 delta 2巡目で `new_conversation?` を server \\ __MODULE__ の
      # 前の第 7 引数へ移した — 変更前の /7 は (..., done?, server) だった
      # ので、移行漏れがあっても record_message/7 自体は存在し続け、
      # existing != nil の分岐では `and` の短絡で not new_conversation? が
      # 評価されず無言で素通りしうる (クロエ M1 の指摘)。moduledoc は
      # is_boolean/1 ガードを「恒久的な保護」と書いたが、クロエの再測定
      # (同一環境での対照付き mutation) で、ガードを外しても既存 1108
      # 件は 1 件も落ちないことが判明した — 恒久保護という記述を
      # 支えるテストが無かった。この test がその欠落を埋める:
      # bool 以外の第 7 引数は必ず raise することを直接 pin する。
      name = start_tracker(:cs_nonboolean_guard)

      assert_raise FunctionClauseError, fn ->
        ConversationStates.record_message("c", "a", "b", "x", 1, false, name, name)
      end
    end
  end

  describe "turn_number バリデーション (#177 review M1)" do
    test "既知の max_turn_number 以下 (重複・遅延) は :stale_turn で拒否し counters を進めない" do
      name = start_tracker(:cs_stale_turn)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)
      assert :ok = ConversationStates.record_message("c", "b", "a", "y", 2, false, true, name)

      # 重複 (直前と同じ turn_number)。
      assert {:error, :stale_turn} =
               ConversationStates.record_message("c", "a", "b", "dup", 2, false, true, name)

      # 遅延到着 (既知の最大値より低い)。
      assert {:error, :stale_turn} =
               ConversationStates.record_message("c", "b", "a", "late", 1, false, true, name)

      # 拒否は turns / max_turn_number を進めない。
      assert %{turns: 2, max_turn_number: 2} = ConversationStates.get("c", name)

      # 新しい turn_number は通常どおり受理される。
      assert :ok = ConversationStates.record_message("c", "a", "b", "z", 3, false, true, name)
      assert %{turns: 3, max_turn_number: 3} = ConversationStates.get("c", name)
    end

    test "brand-new conversation の初回は max_turn_number の制約を受けない" do
      name = start_tracker(:cs_stale_turn_fresh)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 5, false, true, name)
      assert %{max_turn_number: 5} = ConversationStates.get("c", name)
    end
  end

  describe "hard limit 3 種 x tombstone lifecycle 全経路 (#177 review S1, #221)" do
    test "max_turns: tombstone -> conversation_closed -> TTL 後に CID 再利用" do
      {name, clock} =
        start_tracker_with_clock(:cs_lifecycle_turns, max_turns: 1, tombstone_ttl_ms: 1_000)

      pid = Process.whereis(name)

      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)

      assert {:exceeded, :max_turns} =
               ConversationStates.record_message("c", "b", "a", "y", 2, false, true, name)

      assert %{status: :closed, reason: :max_turns} = ConversationStates.get("c", name)

      assert {:error, :conversation_closed} =
               ConversationStates.record_message("c", "a", "b", "z", 3, false, true, name)

      advance_clock(clock, 1_001)
      sync_gc(pid)
      assert ConversationStates.get("c", name) == nil

      assert :ok = ConversationStates.record_message("c", "a", "b", "fresh", 1, false, true, name)
    end

    test "max_tokens: tombstone -> conversation_closed -> TTL 後に CID 再利用" do
      {name, clock} =
        start_tracker_with_clock(:cs_lifecycle_tokens, max_tokens: 10, tombstone_ttl_ms: 1_000)

      pid = Process.whereis(name)
      body = String.duplicate("x", 30)

      assert {:exceeded, :max_tokens} =
               ConversationStates.record_message("c", "a", "b", body, 1, false, true, name)

      assert %{status: :closed, reason: :max_tokens} = ConversationStates.get("c", name)

      assert {:error, :conversation_closed} =
               ConversationStates.record_message("c", "a", "b", "z", 2, false, true, name)

      advance_clock(clock, 1_001)
      sync_gc(pid)
      assert ConversationStates.get("c", name) == nil

      assert :ok = ConversationStates.record_message("c", "a", "b", "fresh", 1, false, true, name)
    end

    test "max_concurrent_agents: tombstone -> conversation_closed -> TTL 後に CID 再利用" do
      {name, clock} =
        start_tracker_with_clock(:cs_lifecycle_agents,
          max_concurrent_agents: 1,
          tombstone_ttl_ms: 1_000
        )

      pid = Process.whereis(name)

      assert {:exceeded, :max_concurrent_agents} =
               ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)

      assert %{status: :closed, reason: :max_concurrent_agents} =
               ConversationStates.get("c", name)

      assert {:error, :conversation_closed} =
               ConversationStates.record_message("c", "a", "b", "z", 2, false, true, name)

      advance_clock(clock, 1_001)
      sync_gc(pid)
      assert ConversationStates.get("c", name) == nil

      # 再利用後も同じ limit がまだ効いているので、CID は「新規」として
      # 受理された上でまた同じ理由で tombstone 化する (拒否ではなく新規受理
      # であることの確認が目的で、以後の挙動は limit 次第)。
      assert {:exceeded, :max_concurrent_agents} =
               ConversationStates.record_message("c", "a", "b", "fresh", 1, false, true, name)
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

      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)
      advance_clock(clock, 101)
      sync_gc(pid)

      assert %{status: :closed, reason: :open_conversation_ttl} =
               ConversationStates.get("c", name)

      assert {:error, :conversation_closed} =
               ConversationStates.record_message("c", "a", "b", "z", 2, false, true, name)

      advance_clock(clock, 101)
      sync_gc(pid)
      assert ConversationStates.get("c", name) == nil

      assert :ok = ConversationStates.record_message("c", "a", "b", "fresh", 1, false, true, name)
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

      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)
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

      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)

      assert {:exceeded, :max_turns} =
               ConversationStates.record_message("c", "b", "a", "y", 2, false, true, name)

      assert Agent.get(notifier, & &1) == []
    end

    test "both_done closure では呼ばれない (両側合意は既に自明で通知不要)" do
      {notifier, on_auto_closed} = capturing_callback()

      {name, _clock} =
        start_tracker_with_clock(:cs_on_auto_closed_bothdone, [], on_auto_closed: on_auto_closed)

      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, true, true, name)

      assert :both_done =
               ConversationStates.record_message("c", "b", "a", "y", 2, true, true, name)

      assert Agent.get(notifier, & &1) == []
    end

    test "callback が例外を投げても GenServer は生存し tombstone 遷移自体は完了する" do
      on_auto_closed = fn _cid, _agent_ids, _reason -> raise "boom" end

      {name, clock} =
        start_tracker_with_clock(:cs_on_auto_closed_raises, [open_conversation_ttl_ms: 1],
          on_auto_closed: on_auto_closed
        )

      pid = Process.whereis(name)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)
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
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)

      # TTL に触れない別会話を、GC 実行時点の now と同時刻で追加する — 巻き
      # 添えの範囲 ((c) の検証対象) を確かめるため、"c" の tombstone 化と
      # 同じ GC ラウンドに同居させつつ、この会話自体は開いたまま残る。
      advance_clock(clock, 5)
      assert :ok = ConversationStates.record_message("other", "x", "y", "z", 1, false, true, name)

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
    assert :ok = ConversationStates.record_message("c1", "a", "b", "x", 1, false, true, name)
    assert :ok = ConversationStates.record_message("c2", "b", "c", "y", 1, false, true, name)

    assert {[{"c1", ["b"]}], 0} =
             ConversationStates.claim_unreachable_targets("a", 50, name)

    assert {[], 0} = ConversationStates.claim_unreachable_targets("zzz", 50, name)

    {claimed, 0} = ConversationStates.claim_unreachable_targets("b", 50, name)
    assert [{"c1", ["a"]}, {"c2", ["c"]}] = Enum.sort(claimed)
  end

  test "unreachable_targets は read-only で planned notice 後の terminal claim を汚さない (#266)" do
    name = start_tracker(:cs_planned_targets)
    assert :ok = ConversationStates.record_message("c1", "a", "b", "x", 1, false, true, name)
    assert :ok = ConversationStates.record_message("c2", "a", "c", "y", 1, false, true, name)

    assert {targets, 1} = ConversationStates.unreachable_targets("a", 1, name)
    assert length(targets) == 1

    # Read-only listing does not consume either the returned row or the capped
    # remainder. A later terminal disconnect can still claim both.
    assert {claimed, 0} = ConversationStates.claim_unreachable_targets("a", 50, name)
    assert Enum.sort(claimed) == [{"c1", ["b"]}, {"c2", ["c"]}]
  end

  test "unreachable_targets は過去の terminal 通知済み peer も planned 復帰対象に戻す (#266)" do
    name = start_tracker(:cs_planned_after_terminal)
    assert :ok = ConversationStates.record_message("c1", "a", "b", "x", 1, false, true, name)

    assert {[{"c1", ["b"]}], 0} =
             ConversationStates.claim_unreachable_targets("a", 50, name)

    # Ordinary crash suppression stays armed, while a later planned cycle
    # can still announce both its downtime and its matching recovery.
    assert {[], 0} = ConversationStates.claim_unreachable_targets("a", 50, name)
    assert {[{"c1", ["b"]}], 0} = ConversationStates.unreachable_targets("a", 50, name)
  end

  test "mark_terminal_targets は required だけを mark し additional を消費しない (#266)" do
    name = start_tracker(:cs_planned_terminal_targets)

    assert :ok =
             ConversationStates.record_message("required", "a", "b", "x", 1, false, true, name)

    assert {[{"required", ["b"]}], 0} =
             ConversationStates.claim_unreachable_targets("a", 50, name)

    assert :ok =
             ConversationStates.record_message("additional", "a", "c", "y", 1, false, true, name)

    assert :ok =
             ConversationStates.record_message(
               "required-fresh",
               "a",
               "e",
               "z",
               1,
               false,
               true,
               name
             )

    required = [
      {"required", ["b"]},
      {"required-fresh", ["e"]},
      {"bounce-only", ["d"]}
    ]

    assert :ok = ConversationStates.mark_terminal_targets("a", required, name)

    # required の既存 entry だけが mark 済み。additional は planned intent の
    # bounded union に無いため消費せず、次の ordinary disconnect に残す。
    assert {[{"additional", ["c"]}], 0} =
             ConversationStates.claim_unreachable_targets("a", 50, name)

    assert {[], 0} = ConversationStates.claim_unreachable_targets("a", 50, name)
    assert ConversationStates.get("bounce-only", name) == nil
  end

  test "閉じた conversation は claim 対象にならない (#131)" do
    name = start_tracker(:cs_participants_closed)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, true, true, name)

    assert :both_done =
             ConversationStates.record_message("c", "b", "a", "y", 2, true, true, name)

    assert {[], 0} = ConversationStates.claim_unreachable_targets("a", 50, name)
  end

  test "同じ conversation を二重に claim しない (フラッピング抑止, #131)" do
    name = start_tracker(:cs_claim_once)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)

    assert {[{"c", ["b"]}], 0} =
             ConversationStates.claim_unreachable_targets("a", 50, name)

    # 再接続しないまま切断を繰り返しても 2 度目は返らない。
    assert {[], 0} = ConversationStates.claim_unreachable_targets("a", 50, name)

    # 相手の発言だけでは解除しない (a はまだ戻ってきていない)。
    assert :ok = ConversationStates.record_message("c", "b", "a", "y", 2, false, true, name)
    assert {[], 0} = ConversationStates.claim_unreachable_targets("a", 50, name)

    # a 自身が同じ conversation で再び発言したら再武装する。
    assert :ok = ConversationStates.record_message("c", "a", "b", "z", 3, false, true, name)

    assert {[{"c", ["b"]}], 0} =
             ConversationStates.claim_unreachable_targets("a", 50, name)
  end

  test "claim は limit で打ち切り、未claim 件数を返す (#131)" do
    name = start_tracker(:cs_claim_limit)

    for n <- 1..3 do
      assert :ok = ConversationStates.record_message("c#{n}", "a", "b", "x", 1, false, true, name)
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

    assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)

    assert {:exceeded, :max_turns} =
             ConversationStates.record_message("c", "a", "b", "y", 2, false, true, name)
  end

  describe "list_for_operator/1 (issue #276)" do
    test "open conversation を participants/turns/tokens/status/started_at 付きで返す" do
      name = start_tracker(:cs_list_open)

      assert :ok =
               ConversationStates.record_message("c1", "b", "a", "hello", 1, false, true, name)

      assert [
               %{
                 "conversation_id" => "c1",
                 "participants" => ["a", "b"],
                 "turns" => 1,
                 "tokens" => tokens,
                 "status" => "open",
                 "started_at" => started_at
               }
             ] = ConversationStates.list_for_operator(name)

      assert tokens > 0
      # ISO8601 の疎な形状チェック — 正確な時刻は clock 注入と無関係の
      # DateTime.utc_now() 由来なのでテストは形状だけを固定する。
      assert {:ok, _, _} = DateTime.from_iso8601(started_at)
    end

    test "closed tombstone は turns=last_turn・tokens=nil だが started_at は保持する (director決定A, issue #276)" do
      name = start_tracker(:cs_list_closed, max_turns: 1)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)

      assert {:exceeded, :max_turns} =
               ConversationStates.record_message("c", "a", "b", "y", 2, false, true, name)

      # last_turn は超過を検出したメッセージ自体もカウントした後の値
      # (evaluate/5 は turns を先に加算してから max_turns 判定する) — 2。
      assert [
               %{
                 "conversation_id" => "c",
                 "participants" => ["a", "b"],
                 "turns" => 2,
                 "tokens" => nil,
                 "status" => "closed",
                 "started_at" => started_at
               }
             ] = ConversationStates.list_for_operator(name)

      assert {:ok, _, _} = DateTime.from_iso8601(started_at)
    end

    test "複数会話を conversation_id 順を問わず全件返す" do
      name = start_tracker(:cs_list_multi)
      assert :ok = ConversationStates.record_message("c1", "a", "b", "x", 1, false, true, name)
      assert :ok = ConversationStates.record_message("c2", "a", "c", "y", 1, false, true, name)

      cids =
        name
        |> ConversationStates.list_for_operator()
        |> Enum.map(& &1["conversation_id"])
        |> Enum.sort()

      assert cids == ["c1", "c2"]
    end

    # issue #276 review follow-up (non-blocking, addressed): operator_turns/1's
    # defensive catch-all. This module never actually produces a third
    # `status` value today (see close_entry/3 and the entry-creation literal
    # in handle_call({:record, ...})) — this test forces the unreachable
    # shape via :sys.replace_state to pin the catch-all itself, since the
    # public API cannot construct it.
    test "未知の status 値でも list_for_operator は crash せず turns=0 を返す (防御的 catch-all)" do
      name = start_tracker(:cs_list_unknown_status)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)

      pid = Process.whereis(name)

      :sys.replace_state(pid, fn state ->
        put_in(state.conversations["c"].status, :some_future_status)
      end)

      assert [%{"conversation_id" => "c", "turns" => 0}] =
               ConversationStates.list_for_operator(name)
    end
  end

  describe "close_by_operator/1 (issue #276)" do
    test "open な会話を close し、reason=:operator_closed の tombstone にする" do
      name = start_tracker(:cs_close_open)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)

      assert {:ok, agent_ids} = ConversationStates.close_by_operator("c", name)
      assert Enum.sort(agent_ids) == ["a", "b"]

      assert %{status: :closed, reason: :operator_closed} =
               ConversationStates.get("c", name)
    end

    test "close 後の list_for_operator は status=closed かつ started_at 保持のまま残る (director決定A)" do
      name = start_tracker(:cs_close_list)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, false, true, name)
      assert {:ok, _} = ConversationStates.close_by_operator("c", name)

      assert [%{"conversation_id" => "c", "status" => "closed", "started_at" => started_at}] =
               ConversationStates.list_for_operator(name)

      assert {:ok, _, _} = DateTime.from_iso8601(started_at)
    end

    test "既に closed な会話への再 close は :conversation_closed で拒否する (冪等、crash しない)" do
      name = start_tracker(:cs_close_twice)
      assert :ok = ConversationStates.record_message("c", "a", "b", "x", 1, true, true, name)

      assert :both_done =
               ConversationStates.record_message("c", "b", "a", "y", 2, true, true, name)

      assert {:error, :conversation_closed} = ConversationStates.close_by_operator("c", name)

      # 拒否された close は tombstone の reason を書き換えない。
      assert %{status: :closed, reason: :both_done} = ConversationStates.get("c", name)
    end

    test "存在しない conversation_id への close は :unknown_conversation_id を返す (crash しない)" do
      name = start_tracker(:cs_close_unknown)

      assert {:error, :unknown_conversation_id} =
               ConversationStates.close_by_operator("no-such-cid", name)
    end
  end
end
