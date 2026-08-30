// @vitest-environment jsdom
// issue #207 (code-review-assessment must-fix 2): parseUserList is
// module-private, so a stubbed KaoiroConnection (as settingsDrawer.
// integration.test.ts and clientProtocolVersion.integration.test.ts use)
// never actually exercises it -- those tests confirm the wire EVENT
// name/version or a pre-formatted UserSummary[] stub, not the server-reply
// -> parser -> UserSummary[] path itself. This pins that real path via a
// REAL connectKaoiro() + fake WebSocket round trip, mirroring
// conversationListWireRoundTrip.integration.test.ts's RespondingWebSocket
// pattern (parseConversationList was pinned the same way, for the same
// reason).
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
      event === "list_users" ? RespondingWebSocket.nextResponse : {};
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

function connect() {
  return connectKaoiro(
    "ws://test/client",
    {
      onStatus: vi.fn(),
      onSnapshot: vi.fn(),
      onEnvelope: vi.fn(),
      onHosts: vi.fn(),
    },
    { transport: RespondingWebSocket, heartbeatIntervalMs: 1000 },
  );
}

describe("listUsers の wire round trip (issue #207 code-review-assessment must-fix 2)", () => {
  beforeEach(() => {
    RespondingWebSocket.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("server の snake_case reply を id/kind/displayName/role へ変換する", async () => {
    RespondingWebSocket.nextResponse = {
      users: [
        { id: "u1", kind: "user", display_name: "あお", role: "operator" },
        { id: "u2", kind: "user", display_name: "ふじ", role: "viewer" },
      ],
    };

    const conn = connect();
    await settleSocket();

    const pending = conn.listUsers();
    await settleSocket();
    const users = await pending;

    expect(users).toEqual([
      { id: "u1", kind: "user", displayName: "あお", role: "operator" },
      { id: "u2", kind: "user", displayName: "ふじ", role: "viewer" },
    ]);
  });

  // code-review-assessment must-fix 2: id/kind/role が値域まで narrow
  // されていることを、型チェックの型検査だけでなく wire round trip で
  // pin する -- 各 malformed variant が個別に落ちることを確認する。
  it("malformed entry だけ落とし、valid entry は活かす (id charset / kind literal / role 語彙)", async () => {
    RespondingWebSocket.nextResponse = {
      users: [
        { id: "ok", kind: "user", display_name: "OK", role: "operator" },
        // id が number
        { id: 123, kind: "user", display_name: "x", role: "operator" },
        // id が AgentId charset 違反 (空白を含む)
        {
          id: "has space",
          kind: "user",
          display_name: "x",
          role: "operator",
        },
        // id が空文字
        { id: "", kind: "user", display_name: "x", role: "operator" },
        // kind が "user" 以外
        { id: "bad-kind", kind: "agent", display_name: "x", role: "operator" },
        // display_name が number (これだけは「string でありさえすれば
        // 何でも許す」方針 -- 型違反はやはり落ちる)
        { id: "bad-name", kind: "user", display_name: 42, role: "operator" },
        // role が語彙外
        {
          id: "bad-role",
          kind: "user",
          display_name: "x",
          role: "superadmin",
        },
        // role が number
        { id: "bad-role-type", kind: "user", display_name: "x", role: 1 },
      ],
    };

    const conn = connect();
    await settleSocket();

    const pending = conn.listUsers();
    await settleSocket();
    const users = await pending;

    expect(users.map((u) => u.id)).toEqual(["ok"]);
  });

  // director 判断 (issue #207 round 2): display_name は値域を狭めない
  // -- 管理画面は既存の不正な名前を直すための面なので、任意の非空文字列
  // 以外(制御文字含む)もそのまま通す。
  it("display_name は制御文字を含む任意の文字列でも通す (director 判断: narrow しない)", async () => {
    RespondingWebSocket.nextResponse = {
      users: [
        {
          id: "u1",
          kind: "user",
          display_name: "bad\x00name",
          role: "operator",
        },
      ],
    };

    const conn = connect();
    await settleSocket();

    const pending = conn.listUsers();
    await settleSocket();
    const users = await pending;

    expect(users).toEqual([
      { id: "u1", kind: "user", displayName: "bad\x00name", role: "operator" },
    ]);
  });

  // code-review-assessment must-fix 1/2: サーバ側の handler は既に
  // Users.all_with_role/1 を 4 field へ明示的に再射影しているが、この
  // クライアント側 parser も独立に同じ性質を持つ -- 万一 extra field
  // (例: source) が wire に乗ってきても、返り値の UserSummary には
  // 一切残らない (許可した 4 key 以外は読まれもしない)。
  it("reply に extra field (例: source) が含まれても返り値には一切残らない", async () => {
    RespondingWebSocket.nextResponse = {
      users: [
        {
          id: "u1",
          kind: "user",
          display_name: "あお",
          role: "operator",
          source: { token: "should-never-surface" },
        },
      ],
    };

    const conn = connect();
    await settleSocket();

    const pending = conn.listUsers();
    await settleSocket();
    const users = await pending;

    expect(users).toEqual([
      { id: "u1", kind: "user", displayName: "あお", role: "operator" },
    ]);
    expect(Object.keys(users[0]!).sort()).toEqual([
      "displayName",
      "id",
      "kind",
      "role",
    ]);
  });

  it("users が配列でない reply は空配列を返す(fail-closed)", async () => {
    RespondingWebSocket.nextResponse = { users: "not-an-array" };

    const conn = connect();
    await settleSocket();

    const pending = conn.listUsers();
    await settleSocket();
    const users = await pending;

    expect(users).toEqual([]);
  });
});
