// @vitest-environment jsdom
// Mount App so operator/connection/join wiring into SettingsDrawer is covered.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationList,
  ConversationSummary,
  Envelope,
  KaoiroConnection,
  KaoiroHandlers,
} from "../src/lib/protocol";

if (
  typeof HTMLDialogElement !== "undefined" &&
  typeof HTMLDialogElement.prototype.showModal !== "function"
) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

const captured = vi.hoisted(() => ({
  handlers: null as KaoiroHandlers | null,
  api: null as Record<string, unknown> | null,
}));

vi.mock("../src/lib/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/protocol")>();
  return {
    ...actual,
    connectKaoiro: (_url: string, handlers: KaoiroHandlers) => {
      captured.handlers = handlers;
      return captured.api as unknown as KaoiroConnection;
    },
    fetchPersonaManifest: async () => ({ kind: "unavailable" }),
    fetchAuthMethods: async () => ({ token: true, oauth: [] }),
  };
});

const App = (await import("../src/App.svelte")).default;

let component: object | null = null;

function conversation(id: string, status: "open" | "closed" = "open"): ConversationSummary {
  return {
    conversationId: id,
    participants: ["host-a.p", "host-b.p"],
    turns: 1,
    tokens: null,
    status,
    startedAt: null,
  };
}

function conversations(items: ConversationSummary[], incomplete = false): ConversationList {
  const list = items as ConversationList;
  Object.defineProperty(list, "incomplete", { value: incomplete });
  return list;
}

function envelope(id: string, state: string): Envelope {
  return {
    version: "0",
    agent_id: id,
    persona: { id: "p", name: id, sprite_set: "p" },
    display_name: id,
    ts: "2026-09-27T00:00:00Z",
    type: "state_change",
    state,
    payload: {},
    ext: { engine: "codex" },
  } as unknown as Envelope;
}

function directoryEntry(id: string) {
  return {
    persona: { id: "p", name: id },
    display_name: id,
    last_seen: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function mountApp(): Promise<KaoiroHandlers> {
  component = mount(App, { target: document.body });
  await vi.waitFor(() => {
    if (!captured.handlers) throw new Error("connectKaoiro not called");
  });
  return captured.handlers!;
}

function makeOperator(h: KaoiroHandlers, agents: Record<string, Envelope>): void {
  h.onJoined?.();
  h.onStatus("connected");
  h.onHosts?.([], false);
  h.onSnapshot(agents);
  h.onSnapshotIncomplete?.(false);
}

async function openSettings(): Promise<void> {
  document.querySelector<HTMLButtonElement>("button.settings-toggle")!.click();
  await tick();
}

async function closeSettings(): Promise<void> {
  document.querySelector<HTMLButtonElement>(
    ".settings-drawer-content button.close",
  )!.click();
  await tick();
}

async function waitForConversationCalls(count: number): Promise<void> {
  await vi.waitFor(() => {
    const list = captured.api?.listConversations as ReturnType<typeof vi.fn>;
    expect(list).toHaveBeenCalledTimes(count);
  });
  await tick();
}

async function prepareBulk(): Promise<HTMLDialogElement> {
  document.querySelector<HTMLButtonElement>(".bulk-reset button")!.click();
  await vi.waitFor(() => {
    expect(
      Array.from(document.querySelectorAll<HTMLDialogElement>("dialog")).some(
        (dialog) => dialog.getAttribute("aria-label") === "一括クリーンアップ確認",
      ),
    ).toBe(true);
  });
  return Array.from(document.querySelectorAll<HTMLDialogElement>("dialog")).find(
    (dialog) => dialog.getAttribute("aria-label") === "一括クリーンアップ確認",
  )!;
}

beforeEach(() => {
  captured.handlers = null;
  const listConversations = vi.fn(async () => conversations([]));
  const closeConversation = vi.fn(async (_id: string) => {});
  const sendSessionReset = vi.fn(async (_id: string, _mode: "clear" | "new") => {});
  captured.api = {
    disconnect: () => {},
    reconnect: () => {},
    notifyOnline: () => {},
    sendInstruction: () => {},
    sendInterrupt: () => {},
    stop: async () => {},
    restore: async () => {},
    deleteAgent: async () => {},
    renameAgent: async () => {},
    listConversations,
    closeConversation,
    sendSessionReset,
    listUsers: async () => [],
    renameUser: async () => {},
  };
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
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  captured.handlers = null;
  captured.api = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SettingsDrawer bulk operator action (issue #423)", () => {
  it("viewerにはbulk controlを出さない", async () => {
    const h = await mountApp();
    h.onJoined?.();
    h.onStatus("connected");
    h.onSnapshot({ "host-a.p": envelope("host-a.p", "idle") });
    await openSettings();
    expect(document.querySelector(".bulk-reset")).toBeNull();
  });

  it("operatorにはfresh snapshotの件数を確認する", async () => {
    const h = await mountApp();
    makeOperator(h, {
      "host-a.p": envelope("host-a.p", "idle"),
      "host-offline.p": envelope("host-offline.p", "disconnected"),
    });
    h.onDirectory?.({
      "host-directory.p": directoryEntry("host-directory.p"),
    });
    await tick();
    await openSettings();
    await waitForConversationCalls(1);
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      conversations([conversation("c-open"), conversation("c-closed", "closed")]),
    );

    const dialog = await prepareBulk();
    expect(dialog.textContent).toContain("会話 1 件");
    expect(dialog.textContent).toMatch(/エージェント\s+1 体/);
    expect(document.querySelector<HTMLButtonElement>(".bulk-reset button")?.disabled).toBe(true);
    expect((captured.api!.listConversations as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it("実行時に追加された会話を含め、確認したsnapshotだけを実行する", async () => {
    const h = await mountApp();
    makeOperator(h, { "host-a.p": envelope("host-a.p", "idle") });
    await openSettings();
    await waitForConversationCalls(1);
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      conversations([conversation("c-a"), conversation("c-b")]),
    );

    const dialog = await prepareBulk();
    expect(dialog.textContent).toContain("会話 2 件");
    dialog.querySelector<HTMLButtonElement>('button.danger')!.click();
    await vi.waitFor(() => {
      expect(api.closeConversation).toHaveBeenCalledTimes(2);
      expect(api.sendSessionReset).toHaveBeenCalledTimes(1);
    });
    expect(api.closeConversation).toHaveBeenNthCalledWith(1, "c-a");
    expect(api.closeConversation).toHaveBeenNthCalledWith(2, "c-b");
    expect(api.sendSessionReset).toHaveBeenCalledWith("host-a.p", "clear");
  });

  it("fresh queryが失敗したら古い表示があっても確認を開かない", async () => {
    const h = await mountApp();
    makeOperator(h, { "host-a.p": envelope("host-a.p", "idle") });
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      conversations([conversation("c-old")]),
    );
    await openSettings();
    await waitForConversationCalls(1);
    (api.listConversations as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("timeout"),
    );
    expect(document.querySelector(".conv-cid")?.textContent).toContain("c-old");
    document.querySelector<HTMLButtonElement>(".bulk-reset button")!.click();
    await vi.waitFor(() => {
      expect(document.querySelector(".bulk-reset [role=status]")?.textContent).toContain("timeout");
    });
    expect(
      document.querySelector('dialog[aria-label="一括クリーンアップ確認"]'),
    ).toBeNull();
    expect(api.closeConversation).not.toHaveBeenCalled();
  });

  it("fresh queryがincompleteなら古い表示があっても確認を開かない", async () => {
    const h = await mountApp();
    makeOperator(h, { "host-a.p": envelope("host-a.p", "idle") });
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      conversations([conversation("c-old")]),
    );
    await openSettings();
    await waitForConversationCalls(1);
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      conversations([conversation("c-partial")], true),
    );

    document.querySelector<HTMLButtonElement>(".bulk-reset button")!.click();
    await vi.waitFor(() => {
      expect(document.querySelector(".bulk-reset [role=status]")?.textContent).toContain(
        "不完全",
      );
    });

    expect(document.querySelector(".conv-cid")?.textContent).toContain("c-old");
    expect(
      document.querySelector('dialog[aria-label="一括クリーンアップ確認"]'),
    ).toBeNull();
    expect(api.closeConversation).not.toHaveBeenCalled();
  });

  it("準備中にdrawerを閉じるとlockを解放し、遅い応答から確認を作らない", async () => {
    const h = await mountApp();
    makeOperator(h, { "host-a.p": envelope("host-a.p", "idle") });
    await openSettings();
    await waitForConversationCalls(1);
    const api = captured.api!;
    const preparation = deferred<ConversationList>();
    (api.listConversations as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      preparation.promise,
    );

    document.querySelector<HTMLButtonElement>(".bulk-reset button")!.click();
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLButtonElement>(".bulk-reset button")?.disabled).toBe(
        true,
      ),
    );
    await closeSettings();
    expect(document.querySelector(".bulk-reset")).toBeNull();

    await openSettings();
    await waitForConversationCalls(3);
    expect(
      document.querySelector('dialog[aria-label="一括クリーンアップ確認"]'),
    ).toBeNull();
    const reopenedButton = document.querySelector<HTMLButtonElement>(".bulk-reset button")!;
    expect(reopenedButton.disabled).toBe(false);

    const newPreparation = deferred<ConversationList>();
    (api.listConversations as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      newPreparation.promise,
    );
    reopenedButton.click();
    await vi.waitFor(() => expect(api.listConversations).toHaveBeenCalledTimes(4));
    expect(reopenedButton.disabled).toBe(true);

    preparation.resolve(conversations([conversation("c-late")]));
    await tick();
    expect(
      document.querySelector('dialog[aria-label="一括クリーンアップ確認"]'),
    ).toBeNull();
    expect(reopenedButton.disabled).toBe(true);

    newPreparation.resolve(conversations([conversation("c-new-run")]));
    await vi.waitFor(() =>
      expect(
        document.querySelector('dialog[aria-label="一括クリーンアップ確認"]'),
      ).not.toBeNull(),
    );
  });

  it("実行中にdrawerを閉じてもsettleまでlockを保持し二重実行させない", async () => {
    const h = await mountApp();
    makeOperator(h, { "host-a.p": envelope("host-a.p", "idle") });
    await openSettings();
    await waitForConversationCalls(1);
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      conversations([conversation("c-one")]),
    );
    const closePending = deferred<void>();
    const resetPending = deferred<void>();
    (api.closeConversation as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      closePending.promise,
    );
    (api.sendSessionReset as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      resetPending.promise,
    );

    const dialog = await prepareBulk();
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    await vi.waitFor(() => expect(api.closeConversation).toHaveBeenCalledTimes(1));
    await closeSettings();
    await openSettings();
    await waitForConversationCalls(3);

    const reopenedButton = document.querySelector<HTMLButtonElement>(".bulk-reset button")!;
    expect(reopenedButton.disabled).toBe(true);
    reopenedButton.click();
    await tick();
    expect(api.listConversations).toHaveBeenCalledTimes(3);
    expect(api.closeConversation).toHaveBeenCalledTimes(1);

    closePending.resolve(undefined);
    await vi.waitFor(() => expect(api.sendSessionReset).toHaveBeenCalledTimes(1));
    expect(reopenedButton.disabled).toBe(true);
    resetPending.resolve(undefined);
    await vi.waitFor(() => expect(reopenedButton.disabled).toBe(false));
    expect(api.closeConversation).toHaveBeenCalledTimes(1);
    expect(api.sendSessionReset).toHaveBeenCalledTimes(1);
  });

  it("失敗後も続行し、曖昧なresetは一度だけ試してsummaryに分ける", async () => {
    const h = await mountApp();
    makeOperator(h, {
      "host-a.p": envelope("host-a.p", "idle"),
      "host-b.p": envelope("host-b.p", "idle"),
      "host-c.p": envelope("host-c.p", "idle"),
      "host-d.p": envelope("host-d.p", "idle"),
      "host-e.p": envelope("host-e.p", "idle"),
      "host-f.p": envelope("host-f.p", "idle"),
    });
    await openSettings();
    await waitForConversationCalls(1);
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      conversations([conversation("c-1"), conversation("c-2")]),
    );
    (api.closeConversation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("unknown_conversation_id"),
    );
    (api.sendSessionReset as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("session_reset_pending"))
      .mockRejectedValueOnce(new Error("unrecognized_future_reason"))
      .mockRejectedValueOnce(new Error("error"))
      .mockRejectedValueOnce(new Error("agent_busy"))
      .mockResolvedValueOnce(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const dialog = await prepareBulk();
    dialog.querySelector<HTMLButtonElement>('button.danger')!.click();
    await vi.waitFor(() => {
      expect(document.querySelector(".spawn-notice")?.textContent).toContain("結果不明 4");
    });
    expect(api.closeConversation).toHaveBeenCalledTimes(2);
    expect(api.sendSessionReset).toHaveBeenCalledTimes(6);
    expect(api.sendSessionReset).toHaveBeenNthCalledWith(1, "host-a.p", "clear");
    expect(api.sendSessionReset).toHaveBeenNthCalledWith(2, "host-b.p", "clear");
    expect(api.sendSessionReset).toHaveBeenNthCalledWith(3, "host-c.p", "clear");
    expect(api.sendSessionReset).toHaveBeenNthCalledWith(4, "host-d.p", "clear");
    expect(api.sendSessionReset).toHaveBeenNthCalledWith(5, "host-e.p", "clear");
    expect(api.sendSessionReset).toHaveBeenNthCalledWith(6, "host-f.p", "clear");
    expect(document.querySelector(".spawn-notice")?.textContent).toContain("close (skip 1)");
    expect(document.querySelector(".spawn-notice")?.textContent).toContain("reset 受付 (skip 1");
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it("directory-onlyとdisconnected agentをreset対象に含めない", async () => {
    const h = await mountApp();
    makeOperator(h, {
      "host-live.p": envelope("host-live.p", "idle"),
      "host-disconnected.p": envelope("host-disconnected.p", "disconnected"),
    });
    h.onDirectory?.({
      "host-directory.p": directoryEntry("host-directory.p"),
    });
    await tick();
    await openSettings();
    await waitForConversationCalls(1);
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      conversations([]),
    );
    const dialog = await prepareBulk();
    expect(dialog.textContent).toMatch(/エージェント\s+1 体/);
    dialog.querySelector<HTMLButtonElement>('button.danger')!.click();
    await vi.waitFor(() => expect(api.sendSessionReset).toHaveBeenCalledTimes(1));
    expect(api.sendSessionReset).toHaveBeenCalledWith("host-live.p", "clear");
  });

  it("同じconnection objectの再joinで残りを止め、古いsummaryを出さない", async () => {
    const h = await mountApp();
    makeOperator(h, { "host-a.p": envelope("host-a.p", "idle") });
    await openSettings();
    await waitForConversationCalls(1);
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      conversations([conversation("c-1"), conversation("c-2")]),
    );
    const firstClose = deferred<void>();
    (api.closeConversation as ReturnType<typeof vi.fn>).mockReturnValueOnce(firstClose.promise);
    const dialog = await prepareBulk();
    dialog.querySelector<HTMLButtonElement>('button.danger')!.click();
    await vi.waitFor(() => expect(api.closeConversation).toHaveBeenCalledTimes(1));

    // Phoenix rejoin keeps the exact connection object; App's reactive join
    // epoch must still invalidate the in-flight bulk snapshot.
    h.onJoined?.();
    h.onStatus("connected");
    h.onSnapshot({ "host-a.p": envelope("host-a.p", "idle") });
    h.onHosts?.([], false);
    await tick();
    firstClose.resolve(undefined);
    await tick();

    expect(api.closeConversation).toHaveBeenCalledTimes(1);
    expect(api.sendSessionReset).not.toHaveBeenCalled();
    expect(document.querySelector(".spawn-notice")?.textContent ?? "").not.toContain("一括操作:");
  });

  it("再joinでoperator権限を失ったら実行を止める", async () => {
    const h = await mountApp();
    makeOperator(h, { "host-a.p": envelope("host-a.p", "idle") });
    await openSettings();
    await waitForConversationCalls(1);
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      conversations([conversation("c-1"), conversation("c-2")]),
    );
    const firstClose = deferred<void>();
    (api.closeConversation as ReturnType<typeof vi.fn>).mockReturnValueOnce(firstClose.promise);
    const dialog = await prepareBulk();
    dialog.querySelector<HTMLButtonElement>('button.danger')!.click();
    await vi.waitFor(() => expect(api.closeConversation).toHaveBeenCalledTimes(1));

    h.onJoined?.();
    await tick();
    firstClose.resolve(undefined);
    await tick();

    expect(api.closeConversation).toHaveBeenCalledTimes(1);
    expect(api.sendSessionReset).not.toHaveBeenCalled();
    expect(document.querySelector(".bulk-reset")).toBeNull();
    expect(document.querySelector(".spawn-notice")?.textContent ?? "").not.toContain("一括操作:");
  });
});
