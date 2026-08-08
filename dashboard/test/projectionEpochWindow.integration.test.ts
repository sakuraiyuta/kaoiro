// @vitest-environment jsdom
// ADR-0051 D4 / D3-3 追補 — driven through App.svelte's REAL handler set.
//
// ふじ 30-10 must-fix M1 called the previous coverage Potemkin: it handed
// `sinceJoin` straight to `applyProjectionEpoch`, so it could never observe
// what actually fills that map. The bug lived exactly there — the buffer's
// window was "between two history pushes", not "this connection's join until
// its history push", so a live row from a dead projection survived into the
// epoch-mismatch merge and came back as a ghost.
//
// These tests mount App.svelte with `connectKaoiro` swapped for a capture,
// then call the handlers App itself wired, in the order the server produces
// them. Nothing about the state machine is re-implemented here.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Envelope, KaoiroHandlers } from "../src/lib/protocol";

const captured = vi.hoisted(() => ({
  handlers: null as KaoiroHandlers | null,
}));

vi.mock("../src/lib/protocol", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/protocol")>();
  return {
    ...actual,
    // Everything else — applyProjectionEpoch, mergeTranscriptEntries,
    // resetTranscriptHistory — stays the production implementation.
    connectKaoiro: (_url: string, handlers: KaoiroHandlers) => {
      captured.handlers = handlers;
      return {
        disconnect: () => {},
        reconnect: () => {},
        notifyOnline: () => {},
        sendInstruction: () => {},
        sendInterrupt: () => {},
        stop: async () => {},
        restore: async () => {},
        deleteAgent: async () => {},
      };
    },
    fetchPersonaManifest: async () => null,
    fetchAuthMethods: async () => ({ token: true, oauth: [] }),
  };
});

const App = (await import("../src/App.svelte")).default;

let component: object | null = null;

function assistantLog(agentId: string, ts: string, text: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: agentId, name: agentId, sprite_set: agentId },
    ts,
    type: "log",
    state: "thinking",
    payload: { kind: "assistant", text },
    ext: {},
  } as unknown as Envelope;
}

function stateEnvelope(agentId: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: agentId, name: agentId, sprite_set: agentId },
    ts: "2026-08-08T00:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    ext: {},
  } as unknown as Envelope;
}

function interAgent(from: string, to: string, ts: string, body: string): Envelope {
  return {
    version: "0",
    agent_id: from,
    persona: { id: from, name: from, sprite_set: from },
    ts,
    type: "inter_agent_message",
    state: "idle",
    payload: {
      to,
      conversation_id: "cid-1",
      turn_number: 1,
      kind: "inform",
      body,
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    },
    ext: {},
  } as unknown as Envelope;
}

/** Mounts App, lets its cookie→ticket→connect chain settle, and returns the
 *  handler set App passed to connectKaoiro — the production glue itself. */
async function mountApp(): Promise<KaoiroHandlers> {
  component = mount(App, { target: document.body });
  await vi.waitFor(() => {
    if (captured.handlers === null) throw new Error("not connected yet");
  });
  return captured.handlers!;
}

/** The operator-visible timeline text. Every assertion below reads this so
 *  it observes what the operator observes, not an internal field. */
async function timelineText(): Promise<string> {
  await tick();
  return document.body.textContent ?? "";
}

beforeEach(() => {
  captured.handlers = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/session/ticket")) {
        return { ok: true, status: 200, json: async () => ({ ticket: "t-1" }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("接続世代つき live buffer (ADR-0051 D4 / ふじ 30-10 M1)", () => {
  /** join → snapshot → hosts → history: the server's own after_join order. */
  async function joinWithHistory(
    h: KaoiroHandlers,
    histories: Record<string, Envelope[]>,
    epoch: string,
    agentIds: string[] = ["agent-a"],
  ): Promise<void> {
    h.onJoined?.();
    h.onSnapshot(
      Object.fromEntries(agentIds.map((id) => [id, stateEnvelope(id)])),
    );
    h.onHosts?.([]);
    h.onHistory?.(histories, {}, "per-pane-v1", epoch);
    await tick();
  }

  it("旧接続の live 行は epoch 不一致で復活しない (新接続の live 行だけ残る)", async () => {
    const h = await mountApp();

    // --- 接続 1: epoch-1 の投影を受け取り、その後 live 行が 1 本届く。
    await joinWithHistory(
      h,
      { "agent-a": [assistantLog("agent-a", "2026-08-08T00:00:01Z", "OLD-HISTORY")] },
      "epoch-1",
    );
    h.onEnvelope(assistantLog("agent-a", "2026-08-08T00:00:02Z", "OLD-LIVE"));
    await tick();
    expect(await timelineText()).toContain("OLD-LIVE");

    // --- 切断 → 再接続。server は再起動しており投影は別物 (epoch-2)。
    h.onStatus("disconnected");
    h.onJoined?.();
    h.onSnapshot({ "agent-a": stateEnvelope("agent-a") });
    h.onHosts?.([]);
    // history 到着前に届く live 行 = この接続の窓に属し、新投影には無い。
    h.onEnvelope(assistantLog("agent-a", "2026-08-08T00:00:04Z", "NEW-LIVE"));
    h.onHistory?.(
      { "agent-a": [assistantLog("agent-a", "2026-08-08T00:00:03Z", "REBUILT")] },
      {},
      "per-pane-v1",
      "epoch-2",
    );

    const text = await timelineText();
    // 新投影 + この接続の live は残る。
    expect(text).toContain("REBUILT");
    expect(text).toContain("NEW-LIVE");
    // 旧投影に属する行は、history 由来も live 由来も亡霊として消える。
    expect(text).not.toContain("OLD-HISTORY");
    expect(text).not.toContain("OLD-LIVE");
  });

  it("epoch 一致なら再接続後も既存の live 行は残る (窓の刈り込みが行き過ぎない)", async () => {
    const h = await mountApp();

    await joinWithHistory(h, {}, "epoch-1");
    h.onEnvelope(assistantLog("agent-a", "2026-08-08T00:00:02Z", "KEEP-ME"));
    await tick();

    h.onStatus("disconnected");
    h.onJoined?.();
    h.onSnapshot({ "agent-a": stateEnvelope("agent-a") });
    h.onHosts?.([]);
    h.onHistory?.({}, {}, "per-pane-v1", "epoch-1");

    expect(await timelineText()).toContain("KEEP-ME");
  });

  it("窓の中で history_reset が来たら buffer 側も同じく消える", async () => {
    const h = await mountApp();

    await joinWithHistory(h, {}, "epoch-1");

    // 新接続の窓を開ける。
    h.onStatus("disconnected");
    h.onJoined?.();
    h.onSnapshot({ "agent-a": stateEnvelope("agent-a") });
    h.onHosts?.([]);
    h.onEnvelope(assistantLog("agent-a", "2026-08-08T00:00:05Z", "PRE-RESET"));
    // wrapper が replay を始めた: この行は投影から落ちる。
    h.onHistoryReset?.("agent-a", false, "replay-1");
    // epoch 不一致で buffer が baseline に昇格する — mirror していないと
    // ここで PRE-RESET が蘇る。
    h.onHistory?.({}, {}, "per-pane-v1", "epoch-2");

    expect(await timelineText()).not.toContain("PRE-RESET");
  });

  it("窓の中で agent_deleted が来たら buffer 側からも消える", async () => {
    const h = await mountApp();

    await joinWithHistory(h, {}, "epoch-1", ["agent-a", "agent-b"]);

    h.onStatus("disconnected");
    h.onJoined?.();
    h.onSnapshot({
      "agent-a": stateEnvelope("agent-a"),
      "agent-b": stateEnvelope("agent-b"),
    });
    h.onHosts?.([]);
    h.onEnvelope(assistantLog("agent-a", "2026-08-08T00:00:05Z", "DOOMED"));
    h.onAgentDeleted?.("agent-a");
    h.onHistory?.({}, {}, "per-pane-v1", "epoch-2");

    expect(await timelineText()).not.toContain("DOOMED");
  });

  it("epoch 破棄でも現行接続の replay marker は生き残る (pulse 抑止を保つ)", async () => {
    const h = await mountApp();

    await joinWithHistory(h, {}, "epoch-1");

    h.onStatus("disconnected");
    h.onJoined?.();
    h.onSnapshot({ "agent-a": stateEnvelope("agent-a") });
    h.onHosts?.([]);
    h.onHistoryReset?.("agent-a", false, "replay-2");
    h.onHistory?.({}, {}, "per-pane-v1", "epoch-2");
    // marker が生きていれば、この replay 行は「新着」扱いされない。
    h.onEnvelope(assistantLog("agent-a", "2026-08-08T00:00:06Z", "REPLAYED"));
    await tick();

    expect(await timelineText()).toContain("REPLAYED");
    expect(document.querySelectorAll(".row.new-arrival").length).toBe(0);
  });

  it("対比: replay 窓の外の live 行は new-arrival として点滅する", async () => {
    const h = await mountApp();

    await joinWithHistory(h, {}, "epoch-1");
    h.onEnvelope(assistantLog("agent-a", "2026-08-08T00:00:06Z", "LIVE-PULSE"));
    await tick();

    expect(document.querySelectorAll(".row.new-arrival").length).toBe(1);
  });
});

// ADR-0051 D3-3 追補 / ふじ 30-10 must-fix M2: a restored IA row is addressed
// to ONE pane. The discriminator used here is `agent_deleted`: deleting the
// named pane must take the row with it. Under the old `envelope` fan-out the
// same row also sat in `payload.to`'s pane and survived the delete — which is
// exactly the mismatch against a reload that M2 reported.
describe("復元 IA の pane 限定注入 (ADR-0051 D3-3 追補 / ふじ 30-10 M2)", () => {
  async function joinAsOperator(h: KaoiroHandlers): Promise<void> {
    h.onJoined?.();
    h.onSnapshot({
      "agent-a": stateEnvelope("agent-a"),
      "agent-b": stateEnvelope("agent-b"),
    });
    h.onHosts?.([]);
    h.onHistory?.({}, {}, "per-pane-v1", "epoch-1");
    await tick();
  }

  it("history_replay_envelope は指定 pane にだけ入る", async () => {
    const h = await mountApp();
    await joinAsOperator(h);

    h.onHistoryReplayEnvelope?.(
      "agent-a",
      interAgent("agent-b", "agent-a", "2026-08-08T00:00:01Z", "RESTORED-IA"),
    );
    await tick();
    expect(await timelineText()).toContain("RESTORED-IA");

    // pane を消すと行も消える = agent-b の pane には入っていない。
    h.onAgentDeleted?.("agent-a");
    expect(await timelineText()).not.toContain("RESTORED-IA");
  });

  it("対比: 通常 envelope の IA は両 pane へ fan-out する (従来動作は不変)", async () => {
    const h = await mountApp();
    await joinAsOperator(h);

    h.onEnvelope(
      interAgent("agent-b", "agent-a", "2026-08-08T00:00:01Z", "LIVE-IA"),
    );
    await tick();
    expect(await timelineText()).toContain("LIVE-IA");

    // 送信側 pane にも複製されているので、受信側 pane を消しても残る。
    h.onAgentDeleted?.("agent-a");
    expect(await timelineText()).toContain("LIVE-IA");
  });
});
