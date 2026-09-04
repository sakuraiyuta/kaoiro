// @vitest-environment jsdom
// issue #276 review follow-up (ふじ B2): parseConversationList is
// module-private, so a stubbed KaoiroConnection (as settingsDrawer.
// integration.test.ts and clientProtocolVersion.integration.test.ts use)
// never actually exercises it — those tests confirm the wire EVENT
// name/version or a pre-formatted ConversationSummary[] stub, not the
// server-reply -> parser -> ConversationSummary[] path itself. This pins
// that real path via a REAL connectKaoiro() + fake WebSocket round trip,
// mirroring launchDefaults.integration.test.ts's RespondingWebSocket
// pattern (getLaunchDefaults' own module-private parser was pinned the
// same way, for the same reason).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectKaoiro } from "../src/lib/protocol";

class RespondingWebSocket {
  static instances: RespondingWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static nextResponse: unknown = {};

  readyState: number = RespondingWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(public url: string) {
    RespondingWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.readyState === RespondingWebSocket.CLOSED) return;
      this.readyState = RespondingWebSocket.OPEN;
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    const [joinRef, ref, topic, event] = JSON.parse(data) as [
      string | null,
      string | null,
      string,
      string,
      unknown,
    ];
    const response =
      event === "list_conversations" ? RespondingWebSocket.nextResponse : {};
    setTimeout(() => {
      if (this.readyState !== RespondingWebSocket.OPEN) return;
      const reply = [
        joinRef,
        ref,
        topic,
        "phx_reply",
        { status: "ok", response },
      ];
      this.onmessage?.({ data: JSON.stringify(reply) });
    }, 0);
  }

  close(): void {
    this.readyState = RespondingWebSocket.CLOSED;
  }
}

async function settleSocket(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(5);
  }
}

describe("listConversations の wire round trip (issue #276 review follow-up)", () => {
  beforeEach(() => {
    RespondingWebSocket.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // director決定A(issue #276): closed tombstone は started_at を保持する
  // -- null になるのは tokens だけで、started_at は open のときと同じ
  // ISO 文字列が乗ってくる。closed fixture に started_at: null を使うと
  // 「closed だから null」という実態と逆の前提を fixture に埋め込んで
  // しまう(こはく review follow-up, ふじ round2 B1)。started_at: null の
  // ケースは legacy/defensive fallback として下の別テストへ分離する。
  it("server の snake_case reply を open/closed(started_at は closed でも保持)・nullable な tokens ごと変換する", async () => {
    RespondingWebSocket.nextResponse = {
      conversations: [
        {
          conversation_id: "c1",
          participants: ["a", "b"],
          turns: 3,
          tokens: 50,
          status: "open",
          started_at: "2026-08-29T00:00:00Z",
        },
        {
          conversation_id: "c2",
          participants: ["c", "d"],
          turns: 5,
          tokens: null,
          status: "closed",
          started_at: "2026-08-20T00:00:00Z",
        },
      ],
    };

    const conn = connectKaoiro(
      "ws://test/client",
      {
        onStatus: vi.fn(),
        onSnapshot: vi.fn(),
        onEnvelope: vi.fn(),
        onHosts: vi.fn(),
      },
      { transport: RespondingWebSocket, heartbeatIntervalMs: 1000 },
    );
    await settleSocket();

    const pending = conn.listConversations();
    await settleSocket();
    const conversations = await pending;

    expect(conversations).toEqual([
      {
        conversationId: "c1",
        participants: ["a", "b"],
        turns: 3,
        tokens: 50,
        status: "open",
        startedAt: "2026-08-29T00:00:00Z",
      },
      {
        conversationId: "c2",
        participants: ["c", "d"],
        turns: 5,
        tokens: null,
        status: "closed",
        startedAt: "2026-08-20T00:00:00Z",
      },
    ]);
    expect(conversations.incomplete).toBe(false);
  });

  it("conversations_incomplete を receiver-observable marker として渡す", async () => {
    RespondingWebSocket.nextResponse = {
      conversations: [],
      conversations_incomplete: true,
    };

    const conn = connectKaoiro(
      "ws://test/client",
      {
        onStatus: vi.fn(),
        onSnapshot: vi.fn(),
        onEnvelope: vi.fn(),
        onHosts: vi.fn(),
      },
      { transport: RespondingWebSocket, heartbeatIntervalMs: 1000 },
    );
    await settleSocket();

    const pending = conn.listConversations();
    await settleSocket();

    expect((await pending).incomplete).toBe(true);
  });

  // started_at: null は「closed だから」ではなく、サーバが値を欠く
  // legacy/defensive fallback のケースとして単独で pin する。status は
  // open/closed どちらでも意味は同じ(値が来なかっただけ)なので open で
  // 代表させる。
  it("started_at が欠測 (null) の reply は startedAt を null のまま通す (legacy/defensive fallback)", async () => {
    RespondingWebSocket.nextResponse = {
      conversations: [
        {
          conversation_id: "c1",
          participants: ["a", "b"],
          turns: 1,
          tokens: 10,
          status: "open",
          started_at: null,
        },
      ],
    };

    const conn = connectKaoiro(
      "ws://test/client",
      {
        onStatus: vi.fn(),
        onSnapshot: vi.fn(),
        onEnvelope: vi.fn(),
        onHosts: vi.fn(),
      },
      { transport: RespondingWebSocket, heartbeatIntervalMs: 1000 },
    );
    await settleSocket();

    const pending = conn.listConversations();
    await settleSocket();
    const conversations = await pending;

    expect(conversations).toEqual([
      {
        conversationId: "c1",
        participants: ["a", "b"],
        turns: 1,
        tokens: 10,
        status: "open",
        startedAt: null,
      },
    ]);
  });

  it("malformed entry だけ落とし、valid entry は活かす", async () => {
    RespondingWebSocket.nextResponse = {
      conversations: [
        {
          conversation_id: "ok",
          participants: ["a", "b"],
          turns: 1,
          tokens: 10,
          status: "open",
          started_at: null,
        },
        // conversation_id が数値
        {
          conversation_id: 123,
          participants: ["a", "b"],
          turns: 1,
          tokens: 10,
          status: "open",
          started_at: null,
        },
        // status が open/closed のどちらでもない
        {
          conversation_id: "bad-status",
          participants: ["a", "b"],
          turns: 1,
          tokens: 10,
          status: "archived",
          started_at: null,
        },
        // participants が配列でない
        {
          conversation_id: "bad-participants",
          participants: "not-an-array",
          turns: 1,
          tokens: 10,
          status: "open",
          started_at: null,
        },
        // turns が数値でない
        {
          conversation_id: "bad-turns",
          participants: ["a", "b"],
          turns: "3",
          tokens: 10,
          status: "open",
          started_at: null,
        },
        // participants は配列だが要素に非 string を含む (advisory,
        // ふじ round2: .every((v) => typeof v === "string") 分岐が
        // 未 pin だった)
        {
          conversation_id: "bad-participant-item",
          participants: ["a", 42],
          turns: 1,
          tokens: 10,
          status: "open",
          started_at: null,
        },
      ],
    };

    const conn = connectKaoiro(
      "ws://test/client",
      {
        onStatus: vi.fn(),
        onSnapshot: vi.fn(),
        onEnvelope: vi.fn(),
        onHosts: vi.fn(),
      },
      { transport: RespondingWebSocket, heartbeatIntervalMs: 1000 },
    );
    await settleSocket();

    const pending = conn.listConversations();
    await settleSocket();
    const conversations = await pending;

    expect(conversations.map((c) => c.conversationId)).toEqual(["ok"]);
  });

  it("carries the server's cross-conversation rally and its verdict (issue #273)", async () => {
    RespondingWebSocket.nextResponse = {
      conversations: [
        {
          conversation_id: "loop",
          participants: ["a", "b"],
          turns: 3,
          tokens: 10,
          status: "open",
          started_at: "2026-09-05T00:00:00Z",
          rally_turns: 18,
          rally_conversations: 2,
          quagmire: true,
        },
        {
          conversation_id: "quiet",
          participants: ["a", "c"],
          turns: 1,
          tokens: 4,
          status: "open",
          started_at: "2026-09-05T00:00:00Z",
          rally_turns: 1,
          rally_conversations: 1,
          quagmire: false,
        },
      ],
    };

    const conn = connectKaoiro(
      "ws://test/client",
      {
        onStatus: vi.fn(),
        onSnapshot: vi.fn(),
        onEnvelope: vi.fn(),
        onHosts: vi.fn(),
      },
      { transport: RespondingWebSocket, heartbeatIntervalMs: 1000 },
    );
    await settleSocket();

    const pending = conn.listConversations();
    await settleSocket();
    const conversations = await pending;

    // The rally is the PAIR's total across conversations, not this row's
    // own turns — the distinction the whole detector rests on.
    expect(conversations[0]).toMatchObject({
      turns: 3,
      rallyTurns: 18,
      rallyConversations: 2,
      quagmire: true,
    });
    expect(conversations[1]).toMatchObject({ rallyTurns: 1, quagmire: false });
  });

  it("leaves the rally fields absent when an older server omits them", async () => {
    RespondingWebSocket.nextResponse = {
      conversations: [
        {
          conversation_id: "legacy",
          participants: ["a", "b"],
          turns: 2,
          tokens: 8,
          status: "open",
          started_at: "2026-09-05T00:00:00Z",
        },
      ],
    };

    const conn = connectKaoiro(
      "ws://test/client",
      {
        onStatus: vi.fn(),
        onSnapshot: vi.fn(),
        onEnvelope: vi.fn(),
        onHosts: vi.fn(),
      },
      { transport: RespondingWebSocket, heartbeatIntervalMs: 1000 },
    );
    await settleSocket();

    const pending = conn.listConversations();
    await settleSocket();
    const conversations = await pending;

    expect(conversations[0]?.rallyTurns).toBeUndefined();
    expect(conversations[0]?.quagmire).toBeUndefined();
  });

  it("conversations が配列でない reply は空配列を返す(fail-closed)", async () => {
    RespondingWebSocket.nextResponse = { conversations: "not-an-array" };

    const conn = connectKaoiro(
      "ws://test/client",
      {
        onStatus: vi.fn(),
        onSnapshot: vi.fn(),
        onEnvelope: vi.fn(),
        onHosts: vi.fn(),
      },
      { transport: RespondingWebSocket, heartbeatIntervalMs: 1000 },
    );
    await settleSocket();

    const pending = conn.listConversations();
    await settleSocket();
    const conversations = await pending;

    expect(conversations).toEqual([]);
  });
});
