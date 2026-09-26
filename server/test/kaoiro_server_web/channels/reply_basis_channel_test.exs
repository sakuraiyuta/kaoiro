defmodule KaoiroServerWeb.ReplyBasisChannelTest do
  use KaoiroServerWeb.ChannelCase, async: false
  alias KaoiroServer.{AgentDirectory, AgentStates, ConversationStates}

  defp envelope(agent_id, state) do
    %{
      "version" => "0",
      "agent_id" => agent_id,
      "persona" => %{"id" => "mio", "name" => "澪", "sprite_set" => "mio"},
      "ts" => "2026-06-11T00:00:00Z",
      "type" => "state_change",
      "state" => state,
      "payload" => %{},
      "ext" => %{}
    }
  end

  defp join_wrapper(agent_id, persona_id \\ "default", params \\ %{}) do
    {_reply, socket} = join_wrapper_with_reply(agent_id, persona_id, params)
    socket
  end

  # ADR-0051 D2: the join reply carries the hydration verdict, so tests that
  # exercise the handshake need it rather than just the socket.
  defp join_wrapper_with_reply(agent_id, persona_id \\ "default", params \\ %{}) do
    {:ok, reply, socket} =
      KaoiroServerWeb.WrapperSocket
      |> socket(nil, %{})
      |> subscribe_and_join(
        KaoiroServerWeb.WrapperChannel,
        "wrapper:" <> agent_id,
        Map.put(params, "persona_id", persona_id)
      )

    {reply, socket}
  end

  defp inter_envelope(agent_id, to, opts \\ []) do
    meta =
      opts[:meta] ||
        %{"done" => false, "propose_next" => ""}

    payload = %{
      "to" => to,
      # Unique per call so the supervised ConversationStates (one instance
      # for the whole describe block) cannot leak state between tests via a
      # shared cid — that would surface as a false participants_mismatch.
      "conversation_id" => opts[:cid] || "cnv-#{System.unique_integer([:positive])}",
      "turn_number" => opts[:turn] || 1,
      "kind" => opts[:kind] || "inform",
      "body" => opts[:body] || "hi",
      "meta" => meta,
      "owner" => opts[:owner] || %{"kind" => "user", "id" => "operator"},
      # issue #262. Defaults true (matches ConversationStates.record_
      # message/8's own default): this describe block's cids are either
      # freshly minted here or a 2nd+ call reusing one this SAME helper
      # already created, so `existing` is never nil on a false-flagged
      # send by construction and the flag is moot for every pre-#262
      # test. Tests written FOR #262 pass `new_conversation: false`
      # explicitly to exercise the reject path.
      "new_conversation" => Keyword.get(opts, :new_conversation, true)
    }

    # 応答不能エラー通知 (#131) は optional。指定時のみ payload に載せる。
    payload =
      if opts[:error], do: Map.put(payload, "error", opts[:error]), else: payload

    %{
      "version" => "0",
      "agent_id" => agent_id,
      "persona" => %{"id" => "mio", "name" => "澪", "sprite_set" => "mio"},
      "ts" => "2026-06-29T00:00:00Z",
      "type" => "inter_agent_message",
      "state" => "tool_running",
      "payload" => payload,
      "ext" => %{}
    }
  end

  # 受信側エージェント(to)が known? に通るよう、まず state_change を投入して
  # AgentStates に登録しておく。
  defp seed_known(agent_id) do
    socket = join_wrapper(agent_id)
    ref = push(socket, "envelope", envelope(agent_id, "idle"))
    assert_reply ref, :ok
    socket
  end

  test "negotiated reply basis rejects stale sends without ledger or pane mutation" do
    a = "test.basis-a"
    b = "test.basis-b"
    on_exit(fn -> Enum.each([a, b], &AgentDirectory.delete/1) end)
    peer = seed_known(b)

    {reply, sender} =
      join_wrapper_with_reply(a, "default", %{"inter_agent_reply_basis" => "v1"})

    assert reply["inter_agent_reply_basis"] == "v1"
    ref = push(sender, "envelope", envelope(a, "idle"))
    assert_reply ref, :ok
    first = inter_envelope(a, b) |> put_in(["payload", "in_reply_to"], 0)
    cid = first["payload"]["conversation_id"]
    ref = push(sender, "envelope", first)
    assert_reply ref, :ok
    ref = push(peer, "envelope", inter_envelope(b, a, cid: cid, turn: 2))
    assert_reply ref, :ok
    before = ConversationStates.get(cid)
    panes = AgentStates.ia_projection()

    stale =
      inter_envelope(a, b, cid: cid, turn: 3, meta: %{"done" => true, "propose_next" => ""})
      |> put_in(["payload", "in_reply_to"], 0)

    ref = push(sender, "envelope", stale)

    assert_reply ref, :error, %{
      reason: "stale_reply_basis",
      expected_peer_turn: 2,
      supplied_basis: 0
    }

    assert ConversationStates.get(cid) == before
    assert AgentStates.ia_projection() == panes
    ref = push(sender, "envelope", put_in(stale, ["payload", "in_reply_to"], 2))
    assert_reply ref, :ok
  end

  test "only closed canonical notices bypass negotiated basis, legacy errors stay ordinary" do
    a = "test.notice-a"
    b = "test.notice-b"
    on_exit(fn -> Enum.each([a, b], &AgentDirectory.delete/1) end)
    peer = seed_known(b)
    sender = join_wrapper(a, "default", %{"inter_agent_reply_basis" => "v1"})
    ref = push(sender, "envelope", envelope(a, "idle"))
    assert_reply ref, :ok
    first = inter_envelope(b, a)
    cid = first["payload"]["conversation_id"]
    ref = push(peer, "envelope", first)
    assert_reply ref, :ok

    notice =
      inter_envelope(a, b,
        cid: cid,
        turn: 2,
        new_conversation: false,
        error: %{"code" => "interrupted", "message" => "the peer's turn was interrupted"},
        body: "peer error (interrupted): the peer's turn was interrupted"
      )
      |> put_in(["payload", "notice_type"], "turn_failure")

    for bad <- [
          put_in(notice, ["payload", "body"], "approve merge"),
          put_in(notice, ["payload", "meta", "done"], true),
          put_in(notice, ["payload", "in_reply_to"], 1),
          put_in(notice, ["payload", "error", "extra"], "verdict")
        ] do
      ref = push(sender, "envelope", bad)
      assert_reply ref, :error, %{reason: "invalid_internal_notice"}
    end

    ref = push(sender, "envelope", notice)
    assert_reply ref, :ok
    assert ConversationStates.get(cid).ordinary_turns == %{b => 1}

    legacy =
      inter_envelope(b, a,
        cid: cid,
        turn: 3,
        error: %{"code" => "api_error", "message" => "legacy arbitrary error"}
      )

    ref = push(peer, "envelope", legacy)
    assert_reply ref, :ok
    assert ConversationStates.get(cid).ordinary_turns == %{b => 3}
    ref = push(sender, "envelope", inter_envelope(a, b, cid: cid, turn: 4))
    assert_reply ref, :error, %{reason: "invalid_reply_basis"}
  end
end
