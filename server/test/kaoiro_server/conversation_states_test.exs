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

  test "通常の record_message は :ok を返しエントリを保持する" do
    name = start_tracker(:cs_basic)
    assert :ok =
             ConversationStates.record_message("c1", "a", "b", "hello", false, name)

    assert %{turns: 1, tokens: tokens, agents: agents, done_by: done_by} =
             ConversationStates.get("c1", name)

    assert MapSet.equal?(agents, MapSet.new(["a", "b"]))
    assert MapSet.size(done_by) == 0
    assert tokens > 0
  end

  test "max_turns を超えると :exceeded :max_turns でエントリを削除する" do
    name = start_tracker(:cs_turns, max_turns: 2)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", false, name)
    assert :ok = ConversationStates.record_message("c", "b", "a", "y", false, name)

    assert {:exceeded, :max_turns} =
             ConversationStates.record_message("c", "a", "b", "z", false, name)

    assert ConversationStates.get("c", name) == nil
  end

  test "max_tokens を超えると :exceeded :max_tokens を返す" do
    name = start_tracker(:cs_tokens, max_tokens: 10)
    # body の token は byte_size/3 + 1 で粗近似(spec)。20 バイトで >10。
    body = String.duplicate("x", 30)

    assert {:exceeded, :max_tokens} =
             ConversationStates.record_message("c", "a", "b", body, false, name)

    assert ConversationStates.get("c", name) == nil
  end

  test "max_concurrent_agents を超えると :exceeded を返す" do
    # 既存エントリの participants と一致しない new agent からの送信は
    # participants_mismatch で蹴られるため、agents 過剰判定単独を確かめるには
    # 1 メッセージ目から 3 名(from=a, to=b)→ to=c に切替えるのではなく、
    # max_concurrent_agents を 1 に絞って最初の一発で agents.size > 1 を発生
    # させる(participants_mismatch 経路を通らない安全な再現)。
    name = start_tracker(:cs_agents, max_concurrent_agents: 1)

    assert {:exceeded, :max_concurrent_agents} =
             ConversationStates.record_message("c", "a", "b", "x", false, name)
  end

  test "両 owner-side が done=true を出すと :both_done を返しエントリ削除" do
    name = start_tracker(:cs_done)
    # 1 メッセージ目: a→b done=false (a だけが参加。done_by 空)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", false, name)
    # 2 メッセージ目: a→b done=true (a が done に入る。b はまだ。:ok)
    assert :ok = ConversationStates.record_message("c", "a", "b", "y", true, name)
    assert %{done_by: done_by} = ConversationStates.get("c", name)
    assert MapSet.equal?(done_by, MapSet.new(["a"]))
    # 3 メッセージ目: b→a done=true (b も done。両側揃って :both_done でエントリ削除)
    assert :both_done =
             ConversationStates.record_message("c", "b", "a", "z", true, name)

    assert ConversationStates.get("c", name) == nil
  end

  test "片側だけ done では :ok のまま (両 owner-side 同意で初めて完了)" do
    name = start_tracker(:cs_one_done)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", true, name)
    # a が done=true、ただし b はまだ。:ok 継続。エントリ生存。
    assert %{done_by: done_by} = ConversationStates.get("c", name)
    assert MapSet.equal?(done_by, MapSet.new(["a"]))
  end

  test "既存 conversation_id を第三者が再利用しようとすると participants_mismatch" do
    name = start_tracker(:cs_pollution)
    assert :ok = ConversationStates.record_message("c", "a", "b", "x", false, name)

    # 攻撃者 c が同じ cid を流用。既存 entry.agents={a,b} に c は含まれない。
    assert {:error, :participants_mismatch} =
             ConversationStates.record_message("c", "c", "b", "evil", false, name)

    # 正規参加者の entry は無傷。
    assert %{turns: 1} = ConversationStates.get("c", name)
  end

  test "max_conversations を超える新規 cid は :too_many_conversations で拒否" do
    name = start_tracker(:cs_cap, max_conversations: 2)
    assert :ok = ConversationStates.record_message("c1", "a", "b", "x", false, name)
    assert :ok = ConversationStates.record_message("c2", "a", "b", "x", false, name)

    assert {:error, :too_many_conversations} =
             ConversationStates.record_message("c3", "a", "b", "x", false, name)

    # 既存エントリへの追加メッセージは通る (cap は新規のみ)
    assert :ok = ConversationStates.record_message("c1", "a", "b", "y", false, name)
  end

  test "limits は GenServer 起動時に Application env から取り込む" do
    name =
      start_tracker(:cs_envread,
        max_turns: 1,
        max_tokens: 100_000,
        max_wallclock_ms: 600_000,
        max_concurrent_agents: 2
      )

    assert :ok = ConversationStates.record_message("c", "a", "b", "x", false, name)
    assert {:exceeded, :max_turns} =
             ConversationStates.record_message("c", "a", "b", "y", false, name)
  end
end
