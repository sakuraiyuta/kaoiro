// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @types/node is not in this workspace's devDeps, but `process` is defined
// in the vitest runtime. Locally declare only the surface this test uses
// (unhandledRejection listener) so svelte-check accepts the reference
// without pulling a full node type import.
declare const process: {
  on: (event: "unhandledRejection", handler: (err: unknown) => void) => void;
  off: (event: "unhandledRejection", handler: (err: unknown) => void) => void;
};

import LaunchDialog from "../src/lib/LaunchDialog.svelte";
import { makeReactiveLaunchDialogProps } from "./reactiveProps.svelte";
import {
  makeCatalogPendingStore,
  makeRefreshPendingStore,
  type EngineCatalogResult,
  type HostInfo,
  type KaoiroConnection,
  type RefreshModelsResult,
} from "../src/lib/protocol";

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

/** Deferred: a Promise plus its resolve/reject handles, so a test can drive
 *  a refreshEngineCatalog() call through the full loading/result cycle. */
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

/** Drains microtasks + one Svelte tick. `await tick()` alone only flushes
 *  Svelte reactivity; a preceding `await Promise.resolve()` flushes the
 *  microtask queue so a chain of `await`s inside a component handler
 *  (refreshingCatalog=false in finally, etc.) settles before assertions. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
  await tick();
}

/** Build a KaoiroConnection stub whose refreshEngineCatalog returns a
 *  Deferred so the test controls when the result arrives. Tracks every
 *  call so assertions can check force flag / call count / ordering. */
function makeConnection() {
  const calls: Array<{
    hostId: string;
    engine: string;
    force: boolean;
    deferred: ReturnType<typeof deferred<EngineCatalogResult>>;
  }> = [];
  const conn = {
    spawn: vi.fn(async () => undefined),
    enumerateSessions: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setEffort: vi.fn(async () => undefined),
    refreshModels: vi.fn(async () => undefined),
    refreshEngineCatalog: vi.fn(
      async (hostId: string, engine: string, force?: boolean) => {
        const d = deferred<EngineCatalogResult>();
        calls.push({ hostId, engine, force: force === true, deferred: d });
        return d.promise;
      },
    ),
  } as unknown as KaoiroConnection;
  return { conn, calls };
}

function claudeHost(): HostInfo {
  return {
    host_id: "host-a",
    personas: [{ id: "fuji", name: "藤", sprite_set: "fuji" }],
    cwd_allowlist: ["/workspace"],
    capabilities: ["claude-code"],
    engines: [
      {
        id: "claude-code",
        models: [
          {
            value: "default",
            display_name: "Default",
            effort_levels: ["low", "medium", "high", "xhigh", "max"],
          },
        ],
      },
    ],
  };
}

function codexHost(): HostInfo {
  return {
    host_id: "host-b",
    personas: [{ id: "fuji", name: "藤", sprite_set: "fuji" }],
    cwd_allowlist: ["/workspace"],
    capabilities: ["codex"],
    engines: [
      {
        id: "codex",
        models: [{ value: "gpt-terra", display_name: "Terra" }],
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
    props: {
      hosts,
      connection: conn,
      sessions: null,
      onClose: vi.fn(),
    },
  });
  mounted.push(component);
  await tick();
  return target;
}

function hostSelect(target: Element): HTMLSelectElement {
  const labels = [...target.querySelectorAll("label")];
  const label = labels.find((n) => n.textContent?.includes("ホスト"));
  const sel = label?.querySelector("select");
  if (!(sel instanceof HTMLSelectElement))
    throw new Error("host select not found");
  return sel;
}

function refreshButton(target: Element): HTMLButtonElement | null {
  const buttons = [...target.querySelectorAll("button")];
  return (
    buttons.find(
      (b) => b.getAttribute("aria-label") === "モデル一覧を再取得",
    ) ?? null
  );
}

async function selectHost(
  target: Element,
  hostId: string,
): Promise<void> {
  const select = hostSelect(target);
  select.value = hostId;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
}

describe("LaunchDialog engine-catalog refresh (Option E, ADR-0039)", () => {
  it("Claude host 選択で auto refresh を force=false で発火する", async () => {
    const { conn, calls } = makeConnection();
    const target = await renderLaunch([claudeHost()], conn);
    await selectHost(target, "host-a");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const auto = calls.at(-1)!;
    expect(auto.hostId).toBe("host-a");
    expect(auto.engine).toBe("claude-code");
    expect(auto.force).toBe(false);
  });

  it("手動 button click は force=true で発火する", async () => {
    const { conn, calls } = makeConnection();
    const target = await renderLaunch([claudeHost()], conn);
    await selectHost(target, "host-a");
    // Settle the auto probe so the button re-enables.
    calls[calls.length - 1]!.deferred.resolve({
      host_id: "host-a",
      engine: "claude-code",
      request_id: "r-auto",
      ok: true,
      models_count: 1,
    });
    await settle();
    const btn = refreshButton(target);
    expect(btn).not.toBeNull();
    btn!.click();
    await settle();
    const manual = calls.at(-1)!;
    expect(manual.force).toBe(true);
  });

  it("loading は catalog_result が届くまで継続する (button disabled)", async () => {
    const { conn, calls } = makeConnection();
    const target = await renderLaunch([claudeHost()], conn);
    await selectHost(target, "host-a");
    await settle();
    const btnDuring = refreshButton(target);
    expect(btnDuring?.disabled).toBe(true);
    expect(btnDuring?.textContent?.trim()).toContain("更新中");
    // Result arrives → button re-enables.
    calls[calls.length - 1]!.deferred.resolve({
      host_id: "host-a",
      engine: "claude-code",
      request_id: "r-1",
      ok: true,
      models_count: 1,
    });
    await settle();
    const btnAfter = refreshButton(target);
    expect(btnAfter?.disabled).toBe(false);
    expect(btnAfter?.textContent?.trim()).not.toContain("更新中");
  });

  it("failure は reason を role=alert で表示する", async () => {
    const { conn, calls } = makeConnection();
    const target = await renderLaunch([claudeHost()], conn);
    await selectHost(target, "host-a");
    calls.at(-1)!.deferred.resolve({
      host_id: "host-a",
      engine: "claude-code",
      request_id: "r-fail",
      ok: false,
      reason: "auth_failed",
    });
    await settle();
    const alert = target.querySelector("[role=\"alert\"]");
    expect(alert?.textContent).toContain("auth_failed");
  });

  it("Codex-only host では refresh button を表示しない", async () => {
    const { conn, calls } = makeConnection();
    const target = await renderLaunch([codexHost()], conn);
    await selectHost(target, "host-b");
    expect(refreshButton(target)).toBeNull();
    // auto refresh も発火しない (engine !== claude-code)
    expect(calls).toHaveLength(0);
  });

  it("host 切替: 旧 host の late result は現 host の state を上書きしない", async () => {
    const { conn, calls } = makeConnection();
    const claude2 = { ...claudeHost(), host_id: "host-a2" };
    const target = await renderLaunch([claudeHost(), claude2], conn);
    await selectHost(target, "host-a");
    // Switch mid-flight to host-a2 without resolving the first request.
    await selectHost(target, "host-a2");
    // Now resolve the STALE first request with a failure.
    calls[0]!.deferred.resolve({
      host_id: "host-a",
      engine: "claude-code",
      request_id: "r-stale",
      ok: false,
      reason: "auth_failed",
    });
    await settle();
    // catalogError must NOT surface (stale from prior host).
    expect(target.querySelector("[role=\"alert\"]")).toBeNull();
  });

  it("Codex 切替で outstanding Claude request は無視され、UI state は reset", async () => {
    const { conn, calls } = makeConnection();
    // Two hosts: one Claude, one Codex.
    const target = await renderLaunch([claudeHost(), codexHost()], conn);
    await selectHost(target, "host-a"); // Claude
    // Switch to Codex host mid-flight.
    await selectHost(target, "host-b");
    // Resolve the Claude request with a failure — must be ignored.
    calls[0]!.deferred.resolve({
      host_id: "host-a",
      engine: "claude-code",
      request_id: "r-claude",
      ok: false,
      reason: "auth_failed",
    });
    await settle();
    expect(target.querySelector("[role=\"alert\"]")).toBeNull();
    expect(refreshButton(target)).toBeNull(); // Codex なので button なし
  });

  it("unmount 後の late result は async continuation も含めて no-crash (藤 review 3-3)", async () => {
    const { conn, calls } = makeConnection();
    const target = await renderLaunch([claudeHost()], conn);
    await selectHost(target, "host-a");
    const component = mounted.pop()!;
    await unmount(component);
    // Track any unhandledRejection during the async chain flush — pin
    // that the alive-guard bails out cleanly through the microtask queue
    // (previous test only observed the sync throw of resolve()).
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(() => {
        calls[0]!.deferred.resolve({
          host_id: "host-a",
          engine: "claude-code",
          request_id: "r-late",
          ok: false,
          reason: "auth_failed",
        });
      }).not.toThrow();
      // Flush microtasks + Svelte reactivity so the async continuation
      // inside triggerCatalogRefresh runs against the unmounted state.
      await settle();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
    void target;
  });

  it("hosts prop の in-place 差替え (catalog だけ更新) では auto refresh を再発火しない (藤 review 3-1)", async () => {
    // hostSupportsClaude は primitive $derived。engines array の identity が
    // 変わっても boolean 値は不変なので、$effect は再実行されない想定。
    // ↑この pin が壊れると updateRegister → hosts broadcast のたびに二重
    // refresh + generation 進行が起きる。
    const { conn, calls } = makeConnection();
    const target = document.createElement("div");
    document.body.append(target);
    const props = makeReactiveLaunchDialogProps({
      hosts: [claudeHost()],
      connection: conn,
      sessions: null,
      onClose: () => {},
    });
    const component = mount(LaunchDialog, { target, props });
    mounted.push(component);
    await settle();
    await selectHost(target, "host-a");
    const callsBefore = calls.length;
    expect(callsBefore).toBeGreaterThanOrEqual(1);
    // Resolve the initial probe so refreshingCatalog=false.
    calls[calls.length - 1]!.deferred.resolve({
      host_id: "host-a",
      engine: "claude-code",
      request_id: "r-1",
      ok: true,
      models_count: 1,
    });
    await settle();
    // Rotate hosts prop with a fresh HostInfo carrying the same
    // capabilities but a rotated engines[].models array identity. This is
    // exactly what updateRegister → hosts broadcast produces.
    props.hosts = [
      {
        ...claudeHost(),
        engines: [
          {
            id: "claude-code",
            models: [
              {
                value: "sonnet",
                display_name: "Sonnet",
                effort_levels: ["low", "medium", "high"],
              },
            ],
          },
        ],
      },
    ];
    await settle();
    // No new probe should have fired — capability boolean unchanged.
    expect(calls.length).toBe(callsBefore);
  });
});

describe("makeCatalogPendingStore (Option E, ADR-0039)", () => {
  it("register → onResult で resolve、pending から削除", async () => {
    const s = makeCatalogPendingStore();
    const p = s.register("req-1");
    s.onResult({
      host_id: "h",
      engine: "claude-code",
      request_id: "req-1",
      ok: true,
      models_count: 3,
    });
    const r = await p;
    expect(r.ok).toBe(true);
    expect(s.size()).toBe(0);
  });

  it("unrelated request_id の onResult は無視する", async () => {
    const s = makeCatalogPendingStore();
    const p = s.register("req-1");
    s.onResult({
      host_id: "h",
      engine: "claude-code",
      request_id: "unrelated",
      ok: true,
      models_count: 1,
    });
    expect(s.size()).toBe(1);
    // resolve for real to clean up
    s.onResult({
      host_id: "h",
      engine: "claude-code",
      request_id: "req-1",
      ok: true,
      models_count: 1,
    });
    await p;
  });

  it("cancel は pending を削除し reject する (unhandled rejection なし)", async () => {
    const s = makeCatalogPendingStore();
    const p = s.register("req-1");
    s.cancel("req-1", "ack failed");
    await expect(p).rejects.toThrow(/ack failed/);
    expect(s.size()).toBe(0);
  });

  it("drain は全 pending を reject し map を空にする", async () => {
    const s = makeCatalogPendingStore();
    const p1 = s.register("a");
    const p2 = s.register("b");
    s.drain("socket closed");
    await expect(p1).rejects.toThrow(/socket closed/);
    await expect(p2).rejects.toThrow(/socket closed/);
    expect(s.size()).toBe(0);
  });

  it("2 つの store は互いに isolated (別 connection の drain が波及しない)", async () => {
    const s1 = makeCatalogPendingStore();
    const s2 = makeCatalogPendingStore();
    const p1 = s1.register("x");
    const p2 = s2.register("y");
    s1.drain("s1 closed");
    await expect(p1).rejects.toThrow(/s1 closed/);
    expect(s2.size()).toBe(1); // s2 は影響なし
    s2.onResult({
      host_id: "h",
      engine: "claude-code",
      request_id: "y",
      ok: true,
      models_count: 2,
    });
    await expect(p2).resolves.toMatchObject({ ok: true });
  });

  it("timeout で pending は自動 reject + 削除", async () => {
    vi.useFakeTimers();
    try {
      const s = makeCatalogPendingStore(100);
      const p = s.register("t");
      const settled = p.catch((e) => `rejected:${(e as Error).message}`);
      await vi.advanceTimersByTimeAsync(100);
      await expect(settled).resolves.toContain("timeout");
      expect(s.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ADR-0039 F9 v2 = 藤 review turn-10 must-fix 3/4: pending store の
// isolation / cancel / drain / timeout / unrelated id を pin。同じ shape
// (CatalogPendingStore と同型) なので同じ観点をなぞる。
describe("makeRefreshPendingStore (Option E F9 v2)", () => {
  const sampleResult = (rid: string, ok = true): RefreshModelsResult => ({
    agent_id: "a.1",
    request_id: rid,
    ok,
    ...(ok ? { models_count: 3 } : { reason: "auth_failed" }),
  });

  it("register → onResult で resolve、pending から削除", async () => {
    const s = makeRefreshPendingStore();
    const p = s.register("r1");
    s.onResult(sampleResult("r1"));
    const r = await p;
    expect(r.ok).toBe(true);
    expect(s.size()).toBe(0);
  });

  it("unrelated request_id は無視 (pending 残る)", async () => {
    const s = makeRefreshPendingStore();
    const p = s.register("r1");
    s.onResult(sampleResult("unrelated"));
    expect(s.size()).toBe(1);
    s.onResult(sampleResult("r1"));
    await p;
  });

  it("cancel は pending を削除 + reject", async () => {
    const s = makeRefreshPendingStore();
    const p = s.register("r1");
    s.cancel("r1", "ack failed");
    await expect(p).rejects.toThrow(/ack failed/);
    expect(s.size()).toBe(0);
  });

  it("drain は全 pending を reject し map を空にする (disconnect 経路)", async () => {
    const s = makeRefreshPendingStore();
    const p1 = s.register("a");
    const p2 = s.register("b");
    s.drain("socket closed");
    await expect(p1).rejects.toThrow(/socket closed/);
    await expect(p2).rejects.toThrow(/socket closed/);
    expect(s.size()).toBe(0);
  });

  it("2 store は相互 isolated (別 connection の drain が波及しない)", async () => {
    const s1 = makeRefreshPendingStore();
    const s2 = makeRefreshPendingStore();
    const p1 = s1.register("x");
    const p2 = s2.register("y");
    s1.drain("s1 closed");
    await expect(p1).rejects.toThrow(/s1 closed/);
    expect(s2.size()).toBe(1);
    s2.onResult(sampleResult("y"));
    await expect(p2).resolves.toMatchObject({ ok: true });
  });

  it("timeout で pending は自動 reject + 削除", async () => {
    vi.useFakeTimers();
    try {
      const s = makeRefreshPendingStore(100);
      const p = s.register("t");
      const settled = p.catch((e) => `rejected:${(e as Error).message}`);
      await vi.advanceTimersByTimeAsync(100);
      await expect(settled).resolves.toContain("timeout");
      expect(s.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
