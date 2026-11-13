import "./isolation.setup";
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
import { parseRoomsSnapshot } from "../src/lib/rooms";
import { roomCleanupTargets } from "../src/lib/roomCleanup";

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

  it("stops after a forbidden conversation close without showing a summary", async () => {
    const h = await mountApp();
    makeOperator(h, { "host-a.p": envelope("host-a.p", "idle") });
    await openSettings();
    await waitForConversationCalls(1);
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      conversations([conversation("c-1"), conversation("c-2")]),
    );
    (api.closeConversation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("forbidden"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dialog = await prepareBulk();
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>(".bulk-reset button")?.disabled).toBe(false));
    expect(api.closeConversation).toHaveBeenCalledTimes(1);
    expect(api.sendSessionReset).not.toHaveBeenCalled();
    expect(document.querySelector(".spawn-notice")?.textContent ?? "").not.toContain("一括操作:");
  });

  it("stops after a forbidden session reset without showing a summary", async () => {
    const h = await mountApp();
    makeOperator(h, {
      "host-a.p": envelope("host-a.p", "idle"),
      "host-b.p": envelope("host-b.p", "idle"),
    });
    await openSettings();
    await waitForConversationCalls(1);
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(conversations([conversation("c-1")]));
    (api.sendSessionReset as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("forbidden"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dialog = await prepareBulk();
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>(".bulk-reset button")?.disabled).toBe(false));
    expect(api.closeConversation).toHaveBeenCalledTimes(1);
    expect(api.sendSessionReset).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".spawn-notice")?.textContent ?? "").not.toContain("一括操作:");
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

describe("room cleanup", () => {
  const membership = { "host-a.p": "blue", "host-b.p": "blue", "host-x.p": "lobby" };
  const roomSnapshot = (members: Record<string, string> = membership) => {
    const snapshot = parseRoomsSnapshot({ rooms: [{ id: "lobby", name: null }, { id: "blue", name: "Blue" }, { id: "empty", name: "Empty" }], memberships: members });
    if (snapshot === null) throw new Error("invalid rooms snapshot");
    return snapshot;
  };
  const item = (id: string, participants: string[], status: "open" | "closed" = "open") =>
    ({ ...conversation(id, status), participants });
  const rows = () => conversations([
    item("c-blue", ["host-a.p", "host-b.p"]),
    item("c-split", ["host-a.p", "host-x.p"]),
    item("c-other", ["host-x.p"]),
    item("c-closed", ["host-a.p", "host-b.p"], "closed"),
  ]);
  async function setupRoom() {
    const h = await mountApp();
    makeOperator(h, { "host-a.p": envelope("host-a.p", "idle"), "host-x.p": envelope("host-x.p", "idle") });
    h.onRoomsSnapshot?.(roomSnapshot());
    await tick();
    return h;
  }
  async function openRoom() {
    document.querySelector<HTMLButtonElement>('[data-room="blue"] button.cleanup')!.click();
    await vi.waitFor(() => expect(document.querySelector('dialog[aria-label="部屋 Blue の後片付け"]')).not.toBeNull());
    return document.querySelector<HTMLDialogElement>('dialog[aria-label="部屋 Blue の後片付け"]')!;
  }
  it("closes only conversations whose participants all belong to the room", async () => {
    await setupRoom();
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockImplementation(async () => rows());
    const dialog = await openRoom();
    expect(dialog.textContent).toContain("会話 1 件");
    expect(dialog.textContent).toContain("agent 1 件");
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    await vi.waitFor(() => expect(api.sendSessionReset).toHaveBeenCalledTimes(1));
    expect(api.closeConversation).toHaveBeenCalledExactlyOnceWith("c-blue");
    expect(api.sendSessionReset).toHaveBeenCalledExactlyOnceWith("host-a.p", "clear");
  });

  it("sends nothing when membership changes after confirmation opens", async () => {
    const h = await setupRoom();
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockImplementation(async () => rows());
    const dialog = await openRoom();
    h.onRoomsSnapshot?.(roomSnapshot({ ...membership, "host-b.p": "lobby", "host-x.p": "blue" }));
    await tick();
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    await vi.waitFor(() => expect(document.querySelector('dialog[aria-label="部屋 Blue の後片付け"]')).toBeNull());
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
    expect(document.querySelector(".spawn-notice")?.textContent).toContain("開き直し");
  });

  it("does not send requests when the confirmation is cancelled", async () => {
    await setupRoom();
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockImplementation(async () => rows());
    const dialog = await openRoom();
    [...dialog.querySelectorAll("button")].find((button) => button.textContent?.trim() === "キャンセル")!.click();
    await tick();
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("rejects a changed conversation set even if its count stays the same", async () => {
    await setupRoom();
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(rows()).mockResolvedValueOnce(
      conversations([item("c-new", ["host-a.p", "host-b.p"])]),
    );
    const dialog = await openRoom();
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    await vi.waitFor(() => expect(document.querySelector('dialog[aria-label="部屋 Blue の後片付け"]')).toBeNull());
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("rejects an offline member change even without conversations", async () => {
    const h = await setupRoom();
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockImplementation(async () => conversations([]));
    const dialog = await openRoom();
    h.onRoomsSnapshot?.(roomSnapshot({ ...membership, "host-b.p": "lobby" }));
    await tick();
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    await vi.waitFor(() => expect(document.querySelector(".spawn-notice")?.textContent).toContain("開き直し"));
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("refuses an unresolved conversation participant", async () => {
    await setupRoom();
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      conversations([item("c-unknown", ["host-a.p", "missing.p"])]),
    );
    document.querySelector<HTMLButtonElement>('[data-room="blue"] button.cleanup')!.click();
    await vi.waitFor(() => expect(document.querySelector(".spawn-notice")?.textContent).toContain("開き直し"));
    expect(document.querySelector('dialog[aria-label="部屋 Blue の後片付け"]')).toBeNull();
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("rejects a newly unresolved participant at confirmation", async () => {
    await setupRoom();
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(rows()).mockResolvedValueOnce(
      conversations([item("c-unknown", ["host-a.p", "missing.p"])]),
    );
    const dialog = await openRoom();
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    await vi.waitFor(() => expect(document.querySelector(".spawn-notice")?.textContent).toContain("開き直し"));
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("rejects a room change while the initial conversation list is loading", async () => {
    const h = await setupRoom();
    const api = captured.api!;
    const pending = deferred<ConversationList>();
    (api.listConversations as ReturnType<typeof vi.fn>).mockReturnValueOnce(pending.promise);
    document.querySelector<HTMLButtonElement>('[data-room="blue"] button.cleanup')!.click();
    h.onRoomsSnapshot?.(roomSnapshot({ ...membership, "host-b.p": "lobby" }));
    await tick();
    pending.resolve(rows());
    await vi.waitFor(() => expect(document.querySelector(".spawn-notice")?.textContent).toContain("開き直し"));
    expect(document.querySelector('dialog[aria-label="部屋 Blue の後片付け"]')).toBeNull();
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("rejects an added membership while preparation is loading", async () => {
    const h = await setupRoom();
    const api = captured.api!;
    const pending = deferred<ConversationList>();
    (api.listConversations as ReturnType<typeof vi.fn>).mockReturnValueOnce(pending.promise);
    document.querySelector<HTMLButtonElement>('[data-room="blue"] button.cleanup')!.click();
    h.onRoomsSnapshot?.(roomSnapshot({ ...membership, "host-extra.p": "lobby" }));
    pending.resolve(rows());
    await vi.waitFor(() => expect(document.querySelector(".spawn-notice")?.textContent).toContain("開き直し"));
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("refuses unresolved inputs when selecting room targets", () => {
    const view = { kind: "loaded" as const, ...roomSnapshot() };
    const agent = { "host-a.p": envelope("host-a.p", "idle") };
    expect(roomCleanupTargets("blue", { kind: "none" }, agent, rows())).toBeNull();
    expect(roomCleanupTargets("blue", { ...view, incomplete: true }, agent, rows())).toBeNull();
    expect(roomCleanupTargets("missing", view, agent, rows())).toBeNull();
    expect(roomCleanupTargets("blue", view, { "missing.p": envelope("missing.p", "idle") }, rows())).toBeNull();
    expect(roomCleanupTargets("blue", { ...view, memberships: new Map([["host-a.p", "missing"]]) }, agent, [])).toBeNull();
    expect(roomCleanupTargets("blue", view, agent, [item("empty", [])])).toBeNull();
    expect(roomCleanupTargets("blue", view, agent, [item("unknown", ["missing.p"])])).toBeNull();
  });

  it("rejects a changed room list while preparation is loading", async () => {
    const h = await setupRoom();
    const api = captured.api!;
    const pending = deferred<ConversationList>();
    (api.listConversations as ReturnType<typeof vi.fn>).mockReturnValueOnce(pending.promise);
    document.querySelector<HTMLButtonElement>('[data-room="blue"] button.cleanup')!.click();
    const next = roomSnapshot();
    h.onRoomsSnapshot?.({ ...next, rooms: [...next.rooms, { id: "extra", name: "Extra" }] });
    pending.resolve(rows());
    await vi.waitFor(() => expect(document.querySelector(".spawn-notice")?.textContent).toContain("開き直し"));
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("rejects membership changes while confirmation is loading", async () => {
    const h = await setupRoom();
    const api = captured.api!;
    const pending = deferred<ConversationList>();
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(rows()).mockReturnValueOnce(pending.promise);
    const dialog = await openRoom();
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    h.onRoomsSnapshot?.(roomSnapshot({ ...membership, "host-b.p": "lobby" }));
    pending.resolve(rows());
    await vi.waitFor(() => expect(document.querySelector(".spawn-notice")?.textContent).toContain("開き直し"));
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("rejects a connected-member change after confirmation opens", async () => {
    const h = await setupRoom();
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockImplementation(async () => rows());
    const dialog = await openRoom();
    h.onSnapshot({ "host-a.p": envelope("host-a.p", "disconnected"), "host-x.p": envelope("host-x.p", "idle") });
    await tick();
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    await vi.waitFor(() => expect(document.querySelector(".spawn-notice")?.textContent).toContain("開き直し"));
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("rejects an incomplete conversation list at confirmation", async () => {
    await setupRoom();
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(rows()).mockResolvedValueOnce(conversations([...rows()], true));
    const dialog = await openRoom();
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    await vi.waitFor(() => expect(document.querySelector(".spawn-notice")?.textContent).toContain("開き直し"));
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("rejects an incomplete room snapshot at preparation", async () => {
    const h = await setupRoom();
    h.onRoomsSnapshot?.({ ...roomSnapshot(), incomplete: true });
    await tick();
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(rows());
    document.querySelector<HTMLButtonElement>('[data-room="blue"] button.cleanup')!.click();
    await vi.waitFor(() => expect(document.querySelector(".spawn-notice")?.textContent).toContain("開き直し"));
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("rejects an incomplete conversation list at preparation", async () => {
    await setupRoom();
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(conversations([], true));
    document.querySelector<HTMLButtonElement>('[data-room="blue"] button.cleanup')!.click();
    await vi.waitFor(() => expect(document.querySelector(".spawn-notice")?.textContent).toContain("開き直し"));
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("rejects an unavailable conversation list at confirmation", async () => {
    await setupRoom();
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(rows()).mockRejectedValueOnce(new Error("timeout"));
    const dialog = await openRoom();
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    await vi.waitFor(() => expect(document.querySelector(".spawn-notice")?.textContent).toContain("開き直し"));
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("stops a pending confirmation after a rejoin", async () => {
    const h = await setupRoom();
    const api = captured.api!;
    const pending = deferred<ConversationList>();
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(rows()).mockReturnValueOnce(pending.promise);
    const dialog = await openRoom();
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    h.onJoined?.();
    h.onStatus("connected");
    h.onHosts?.([], false);
    h.onSnapshot({ "host-a.p": envelope("host-a.p", "idle"), "host-x.p": envelope("host-x.p", "idle") });
    h.onSnapshotIncomplete?.(false);
    h.onRoomsSnapshot?.(roomSnapshot());
    await tick();
    pending.resolve(rows());
    await vi.waitFor(() => expect(document.querySelector('dialog[aria-label="部屋 Blue の後片付け"]')).toBeNull());
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("does not query or send after the confirmation becomes stale", async () => {
    const h = await setupRoom();
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(rows());
    const dialog = await openRoom();
    h.onJoined?.();
    dialog.querySelector<HTMLButtonElement>("button.danger")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(api.listConversations).toHaveBeenCalledTimes(1);
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("keeps the shared bulk lock until a room cleanup finishes", async () => {
    await setupRoom();
    const api = captured.api!;
    const pending = deferred<void>();
    (api.listConversations as ReturnType<typeof vi.fn>).mockImplementation(async () => rows());
    (api.closeConversation as ReturnType<typeof vi.fn>).mockReturnValueOnce(pending.promise);
    const dialog = await openRoom();
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    await vi.waitFor(() => expect(api.closeConversation).toHaveBeenCalledTimes(1));
    expect(document.querySelector<HTMLButtonElement>('[data-room="blue"] button.cleanup')!.disabled).toBe(true);
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    expect(api.closeConversation).toHaveBeenCalledTimes(1);
    pending.resolve(undefined);
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-room="blue"] button.cleanup')!.disabled).toBe(false));
    expect(api.sendSessionReset).toHaveBeenCalledTimes(1);
  });

  it("does not start two preparations from consecutive events", async () => {
    await setupRoom();
    const api = captured.api!;
    const pending = deferred<ConversationList>();
    (api.listConversations as ReturnType<typeof vi.fn>).mockReturnValueOnce(pending.promise);
    const button = document.querySelector<HTMLButtonElement>('[data-room="blue"] button.cleanup')!;
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(api.listConversations).toHaveBeenCalledTimes(1);
    pending.resolve(rows());
    await vi.waitFor(() => expect(document.querySelector('dialog[aria-label="部屋 Blue の後片付け"]')).not.toBeNull());
  });

  it("does not start two confirmations from consecutive events", async () => {
    await setupRoom();
    const api = captured.api!;
    const pending = deferred<ConversationList>();
    (api.listConversations as ReturnType<typeof vi.fn>).mockResolvedValueOnce(rows()).mockReturnValueOnce(pending.promise);
    const dialog = await openRoom();
    const button = dialog.querySelector<HTMLButtonElement>("button.danger")!;
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(api.listConversations).toHaveBeenCalledTimes(2);
    pending.resolve(rows());
    await vi.waitFor(() => expect(api.sendSessionReset).toHaveBeenCalledTimes(1));
  });

  it("does not dismiss an executing cleanup on Escape", async () => {
    await setupRoom();
    const api = captured.api!;
    const pending = deferred<void>();
    (api.listConversations as ReturnType<typeof vi.fn>).mockImplementation(async () => rows());
    (api.closeConversation as ReturnType<typeof vi.fn>).mockReturnValueOnce(pending.promise);
    const dialog = await openRoom();
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    await vi.waitFor(() => expect(api.closeConversation).toHaveBeenCalledTimes(1));
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await tick();
    expect(document.querySelector('dialog[aria-label="部屋 Blue の後片付け"]')).not.toBeNull();
    pending.resolve(undefined);
    await vi.waitFor(() => expect(document.querySelector('dialog[aria-label="部屋 Blue の後片付け"]')).toBeNull());
  });

  it("does not start preparation with an incomplete agent snapshot", async () => {
    const h = await setupRoom();
    h.onSnapshotIncomplete?.(true);
    await tick();
    const api = captured.api!;
    document.querySelector<HTMLButtonElement>('[data-room="blue"] button.cleanup')!.click();
    await tick();
    expect(api.listConversations).not.toHaveBeenCalled();
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("does not finish preparing after a rejoin", async () => {
    const h = await setupRoom();
    const api = captured.api!;
    const pending = deferred<ConversationList>();
    (api.listConversations as ReturnType<typeof vi.fn>).mockReturnValueOnce(pending.promise);
    document.querySelector<HTMLButtonElement>('[data-room="blue"] button.cleanup')!.click();
    h.onJoined?.(); h.onStatus("connected"); h.onHosts?.([], false);
    h.onSnapshot({ "host-a.p": envelope("host-a.p", "idle"), "host-x.p": envelope("host-x.p", "idle") });
    h.onSnapshotIncomplete?.(false); h.onRoomsSnapshot?.(roomSnapshot());
    await tick();
    pending.resolve(rows());
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-room="blue"] button.cleanup')?.disabled).toBe(false));
    expect(document.querySelector('dialog[aria-label="部屋 Blue の後片付け"]')).toBeNull();
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("summarizes partial failures using the shared cleanup execution", async () => {
    await setupRoom();
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockImplementation(async () => rows());
    (api.closeConversation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("unknown_conversation_id"));
    (api.sendSessionReset as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("timeout"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dialog = await openRoom();
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    await vi.waitFor(() => expect(document.querySelector(".spawn-notice")?.textContent).toContain("結果不明 1"));
    expect(api.closeConversation).toHaveBeenCalledExactlyOnceWith("c-blue");
    expect(api.sendSessionReset).toHaveBeenCalledExactlyOnceWith("host-a.p", "clear");
    expect(document.querySelector(".spawn-notice")?.textContent).toContain("close (skip 1)");
  });

  it("stops a room cleanup on a forbidden close without a summary", async () => {
    await setupRoom();
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockImplementation(async () => rows());
    (api.closeConversation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("forbidden"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dialog = await openRoom();
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    await vi.waitFor(() => expect(document.querySelector('dialog[aria-label="部屋 Blue の後片付け"]')).toBeNull());
    expect(api.closeConversation).toHaveBeenCalledTimes(1);
    expect(api.sendSessionReset).not.toHaveBeenCalled();
    expect(document.querySelector(".spawn-notice")?.textContent ?? "").not.toContain("一括操作:");
  });

  it("confirms an empty room with zero counts and sends nothing", async () => {
    await setupRoom();
    const api = captured.api!;
    (api.listConversations as ReturnType<typeof vi.fn>).mockImplementation(async () => conversations([]));
    document.querySelector<HTMLButtonElement>('[data-room="empty"] button.cleanup')!.click();
    await vi.waitFor(() => expect(document.querySelector('dialog[aria-label="部屋 Empty の後片付け"]')).not.toBeNull());
    const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="部屋 Empty の後片付け"]')!;
    expect(dialog.textContent).toContain("会話 0 件");
    expect(dialog.textContent).toContain("agent 0 件");
    dialog.querySelector<HTMLButtonElement>("button.danger")!.click();
    await vi.waitFor(() => expect(document.querySelector('dialog[aria-label="部屋 Empty の後片付け"]')).toBeNull());
    expect(api.closeConversation).not.toHaveBeenCalled();
    expect(api.sendSessionReset).not.toHaveBeenCalled();
  });

  it("offers cleanup when there are no agents anywhere", async () => {
    const h = await mountApp();
    makeOperator(h, {});
    h.onRoomsSnapshot?.(roomSnapshot({}));
    await tick();
    expect(document.querySelector('[data-room="empty"] button.cleanup')).not.toBeNull();
  });

  it("does not expose room cleanup to a viewer", async () => {
    const h = await mountApp();
    h.onJoined?.(); h.onStatus("connected");
    h.onSnapshot({ "host-a.p": envelope("host-a.p", "idle") });
    h.onRoomsSnapshot?.(roomSnapshot());
    await tick();
    expect(document.querySelector("button.cleanup")).toBeNull();
  });
});
