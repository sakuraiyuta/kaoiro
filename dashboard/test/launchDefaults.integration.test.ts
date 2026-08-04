// @vitest-environment jsdom
// issue #88: LaunchDialog persona-scoped effort default. Component-level
// coverage for the two ふじ-mandated pins that a pure-function unit test
// cannot reach without mounting the component: (e) a late getLaunchDefaults()
// reply must not override a manual effort pick, and (query failure) must
// fall back to the model's default_effort without blocking launch. Mirrors
// engineCatalogRefresh.integration.test.ts's harness (stubbed
// KaoiroConnection, DOM-driven interaction, no real socket).
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @types/node is not in this workspace's devDeps, but `process` is defined
// in the vitest runtime (mirrors engineCatalogRefresh.integration.test.ts).
declare const process: {
  on: (event: "unhandledRejection", handler: (err: unknown) => void) => void;
  off: (event: "unhandledRejection", handler: (err: unknown) => void) => void;
};

import LaunchDialog from "../src/lib/LaunchDialog.svelte";
import { makeReactiveLaunchDialogProps } from "./reactiveProps.svelte";
import { connectKaoiro } from "../src/lib/protocol";
import type { HostInfo, KaoiroConnection } from "../src/lib/protocol";

const mounted: object[] = [];

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (r: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
  await tick();
}

/** Build a KaoiroConnection stub whose getLaunchDefaults() returns a
 *  Deferred the test controls, plus no-op stubs for the rest of the
 *  interface surface LaunchDialog touches. */
function makeConnection() {
  const launchDefaultsCalls: Array<ReturnType<typeof deferred<Record<string, string>>>> = [];
  const conn = {
    spawn: vi.fn(async () => ({ agentId: "host-a.new" })),
    enumerateSessions: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setEffort: vi.fn(async () => undefined),
    refreshModels: vi.fn(async () => undefined),
    refreshEngineCatalog: vi.fn(async () => ({
      host_id: "host-a",
      engine: "claude-code",
      request_id: "r",
      ok: true,
    })),
    getLaunchDefaults: vi.fn(async () => {
      const d = deferred<Record<string, string>>();
      launchDefaultsCalls.push(d);
      return d.promise;
    }),
  } as unknown as KaoiroConnection;
  return { conn, launchDefaultsCalls };
}

function claudeHost(personas: HostInfo["personas"]): HostInfo {
  return {
    host_id: "host-a",
    personas,
    cwd_allowlist: ["/workspace"],
    capabilities: ["claude-code"],
    engines: [
      {
        id: "claude-code",
        models: [
          {
            value: "opus",
            display_name: "Opus",
            effort_levels: ["low", "medium", "high", "xhigh"],
            default_effort: "medium",
          },
        ],
      },
    ],
  };
}

async function renderLaunch(
  hosts: HostInfo[],
  conn: KaoiroConnection,
): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(LaunchDialog, {
    target,
    props: { hosts, connection: conn, sessions: null, onClose: vi.fn() },
  });
  mounted.push(component);
  await settle();
  return target;
}

function labelSelect(target: Element, labelText: string): HTMLSelectElement {
  const labels = [...target.querySelectorAll("label")];
  const label = labels.find((n) => n.textContent?.includes(labelText));
  const sel = label?.querySelector("select");
  if (!(sel instanceof HTMLSelectElement)) {
    throw new Error(`select for label "${labelText}" not found`);
  }
  return sel;
}

async function change(select: HTMLSelectElement, value: string): Promise<void> {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
}

async function selectModel(target: Element, value: string): Promise<void> {
  await change(labelSelect(target, "モデル"), value);
}

async function selectEffort(target: Element, value: string): Promise<void> {
  await change(labelSelect(target, "effort"), value);
}

async function selectPersona(target: Element, value: string): Promise<void> {
  await change(labelSelect(target, "ペルソナ"), value);
}

describe("LaunchDialog 前回 effort default (issue #88)", () => {
  it("getLaunchDefaults の resolve で persona の前回 effort が反映される", async () => {
    const { conn, launchDefaultsCalls } = makeConnection();
    const target = await renderLaunch(
      [claudeHost([{ id: "fuji", name: "藤", sprite_set: "fuji" }])],
      conn,
    );
    await selectModel(target, "opus");
    expect(labelSelect(target, "effort").value).toBe("medium");

    launchDefaultsCalls[0]!.resolve({ fuji: "high" });
    await settle();

    expect(labelSelect(target, "effort").value).toBe("high");
  });

  it("query 失敗時は default_effort に留まり、起動は block されない", async () => {
    const { conn, launchDefaultsCalls } = makeConnection();
    const target = await renderLaunch(
      [claudeHost([{ id: "fuji", name: "藤", sprite_set: "fuji" }])],
      conn,
    );
    await selectModel(target, "opus");
    expect(labelSelect(target, "effort").value).toBe("medium");

    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      launchDefaultsCalls[0]!.reject(new Error("forbidden"));
      await settle();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
    // Falls back to whatever chooseModel already computed — never blocks.
    expect(labelSelect(target, "effort").value).toBe("medium");
    const launchButton = [...target.querySelectorAll("button")].find(
      (b) => b.type === "submit",
    );
    expect(launchButton?.disabled).toBe(false);
  });

  it("手動 effort 選択の後に届いた reply は上書きしない", async () => {
    const { conn, launchDefaultsCalls } = makeConnection();
    const target = await renderLaunch(
      [claudeHost([{ id: "fuji", name: "藤", sprite_set: "fuji" }])],
      conn,
    );
    await selectModel(target, "opus");
    await selectEffort(target, "low");
    expect(labelSelect(target, "effort").value).toBe("low");

    // Late reply disagrees with the manual pick — must be ignored.
    launchDefaultsCalls[0]!.resolve({ fuji: "xhigh" });
    await settle();

    expect(labelSelect(target, "effort").value).toBe("low");
  });

  it("persona 切替では新しい persona の default を再適用する", async () => {
    const { conn, launchDefaultsCalls } = makeConnection();
    const target = await renderLaunch(
      [
        claudeHost([
          { id: "fuji", name: "藤", sprite_set: "fuji" },
          { id: "ao", name: "あお", sprite_set: "ao" },
        ]),
      ],
      conn,
    );
    await selectModel(target, "opus");
    launchDefaultsCalls[0]!.resolve({ fuji: "high", ao: "low" });
    await settle();
    expect(labelSelect(target, "effort").value).toBe("high");

    // Manually override for 藤, then switch to あお — the NEW persona's
    // default applies, not 藤's stale manual pick.
    await selectEffort(target, "xhigh");
    expect(labelSelect(target, "effort").value).toBe("xhigh");

    await selectPersona(target, "ao");
    expect(labelSelect(target, "effort").value).toBe("low");
  });

  it("preference の無い persona へ切り替えると旧 persona の effort を残さず default_effort に戻す (mapping absent, ふじ must-fix 1)", async () => {
    const { conn, launchDefaultsCalls } = makeConnection();
    const target = await renderLaunch(
      [
        claudeHost([
          { id: "fuji", name: "藤", sprite_set: "fuji" },
          { id: "ao", name: "あお", sprite_set: "ao" },
        ]),
      ],
      conn,
    );
    await selectModel(target, "opus");
    // Only 藤 has a mapping entry — あお is absent entirely.
    launchDefaultsCalls[0]!.resolve({ fuji: "high" });
    await settle();
    expect(labelSelect(target, "effort").value).toBe("high");

    await selectPersona(target, "ao");
    // Must NOT stay "high" (藤's stale value) — falls back to the
    // model's own default_effort.
    expect(labelSelect(target, "effort").value).toBe("medium");
  });

  it("preference が現在モデルで無効な persona へ切り替えると旧 persona の effort を残さず default_effort に戻す (mapping invalid, ふじ must-fix 1)", async () => {
    const { conn, launchDefaultsCalls } = makeConnection();
    const target = await renderLaunch(
      [
        claudeHost([
          { id: "fuji", name: "藤", sprite_set: "fuji" },
          { id: "ao", name: "あお", sprite_set: "ao" },
        ]),
      ],
      conn,
    );
    await selectModel(target, "opus");
    // あお has a mapping entry, but "ultra" is not in opus's effort_levels.
    launchDefaultsCalls[0]!.resolve({ fuji: "high", ao: "ultra" });
    await settle();
    expect(labelSelect(target, "effort").value).toBe("high");

    await selectPersona(target, "ao");
    expect(labelSelect(target, "effort").value).toBe("medium");
  });

  it("現在モデルの effort_levels に無い preference は適用されず default_effort のまま", async () => {
    const { conn, launchDefaultsCalls } = makeConnection();
    const target = await renderLaunch(
      [claudeHost([{ id: "fuji", name: "藤", sprite_set: "fuji" }])],
      conn,
    );
    await selectModel(target, "opus");
    launchDefaultsCalls[0]!.resolve({ fuji: "ultra" });
    await settle();

    expect(labelSelect(target, "effort").value).toBe("medium");
  });

  it("unmount 後の late reply は no-crash (藤 review 3-3 と同型)", async () => {
    const { conn, launchDefaultsCalls } = makeConnection();
    const target = await renderLaunch(
      [claudeHost([{ id: "fuji", name: "藤", sprite_set: "fuji" }])],
      conn,
    );
    await selectModel(target, "opus");
    const component = mounted.pop()!;
    await unmount(component);

    expect(() => {
      launchDefaultsCalls[0]!.resolve({ fuji: "high" });
    }).not.toThrow();
    await settle();
    void target;
  });

  it("hosts prop の in-place 差替え (unrelated broadcast) は手動選択を上書きしない", async () => {
    const { conn, launchDefaultsCalls } = makeConnection();
    const target = document.createElement("div");
    document.body.append(target);
    const props = makeReactiveLaunchDialogProps({
      hosts: [claudeHost([{ id: "fuji", name: "藤", sprite_set: "fuji" }])],
      connection: conn,
      sessions: null,
      onClose: () => {},
    });
    const component = mount(LaunchDialog, { target, props });
    mounted.push(component);
    await settle();

    await selectModel(target, "opus");
    launchDefaultsCalls[0]!.resolve({ fuji: "high" });
    await settle();
    await selectEffort(target, "low");
    expect(labelSelect(target, "effort").value).toBe("low");

    // Rotate hosts prop in place (same persona set, unrelated field churn)
    // — must not re-apply the persona default over the manual pick.
    props.hosts = [
      { ...props.hosts[0]!, cwd_allowlist: ["/workspace", "/other"] },
    ];
    await settle();

    expect(labelSelect(target, "effort").value).toBe("low");
  });
});

// Wire-level fail-closed parsing (ふじ review): a malformed persona_id/
// effort entry is dropped, but the rest of the map survives — pinned
// against a REAL getLaunchDefaults() round trip, not just the parser in
// isolation, since the parser itself is module-private (mirrors how
// EngineCatalogResult / parseCatalogResult are covered in protocol.test.ts).
describe("getLaunchDefaults の fail-closed parse (issue #88)", () => {
  class RespondingWebSocket {
    static instances: RespondingWebSocket[] = [];
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

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
        event === "launch_defaults"
          ? {
              defaults: {
                fuji: "high",
                "": "low",
                ao: "",
                gen: 42,
                mira: "medium",
              },
            }
          : {};
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

  beforeEach(() => {
    RespondingWebSocket.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("malformed entry だけ落とし、valid entry は活かす", async () => {
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

    const pending = conn.getLaunchDefaults();
    await settleSocket();
    const defaults = await pending;

    expect(defaults).toEqual({ fuji: "high", mira: "medium" });
  });
});
