// @vitest-environment jsdom
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
        renameAgent: async () => {},
      };
    },
    fetchPersonaManifest: async () => null,
    fetchAuthMethods: async () => ({ token: true, oauth: [] }),
  };
});

const App = (await import("../src/App.svelte")).default;

let component: object | null = null;

function stateEnvelope(agentId: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: agentId, name: agentId, sprite_set: agentId },
    ts: "2026-08-28T00:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
  } as unknown as Envelope;
}

function taskEnvelope(agentId: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    persona: { id: agentId, name: agentId, sprite_set: agentId },
    ts: "2026-08-28T00:00:00Z",
    type: "task",
    state: "idle",
    payload: {
      kind: "started",
      agent_id: agentId,
      task_id: "task-a",
      task_type: "local_agent",
      status: "running",
    },
  } as unknown as Envelope;
}

async function mountApp(): Promise<KaoiroHandlers> {
  component = mount(App, { target: document.body });
  await vi.waitFor(() => {
    if (captured.handlers === null) throw new Error("not connected yet");
  });
  return captured.handlers!;
}

beforeEach(() => {
  captured.handlers = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      if (String(input).includes("/session/ticket")) {
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
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("snapshot_incomplete の可観測性 (issue #203 V-4)", () => {
  it("省略を表示し、次の join では新 snapshot 前に古い警告を消す", async () => {
    const handlers = await mountApp();
    handlers.onSnapshot({ "agent-a": stateEnvelope("agent-a") });
    handlers.onSnapshotIncomplete?.(true);
    await tick();

    expect(document.querySelector(".snapshot-notice")?.textContent).toContain(
      "snapshot の上限により表示されていません",
    );

    handlers.onJoined?.();
    await tick();
    expect(document.querySelector(".snapshot-notice")).toBeNull();
  });

  it("delivery projection の省略も表示する", async () => {
    const handlers = await mountApp();
    handlers.onDeliverySnapshotIncomplete?.(true);
    await tick();

    expect(document.querySelector(".snapshot-notice")?.textContent).toContain(
      "inter-agent 配送確認",
    );
  });

  it("rejoin の 0/1/2 frame prefix では前世代の 3 projection を残さない", async () => {
    const handlers = await mountApp();
    const agent = stateEnvelope("agent-a");

    handlers.onSnapshot({ "agent-a": agent });
    handlers.onTaskSnapshot?.({ "agent-a": { "task-a": taskEnvelope("agent-a") } });
    handlers.onDeliverySnapshot?.({
      "agent-a": { issued_seq: 2, acked_seq: 1, pending_since: "2026-08-28T00:00:00Z" },
    });
    await tick();
    expect(document.querySelector(".task-ring")).not.toBeNull();

    document.querySelector<HTMLButtonElement>("button.open")?.click();
    await tick();
    expect(document.querySelector("[data-testid='inter-agent-delivery-status']")).not.toBeNull();
    document.querySelector<HTMLButtonElement>("button.back")?.click();
    await tick();

    // 0 frame: a dead rejoin has no authority to retain the old generation.
    handlers.onJoined?.();
    await tick();
    expect(document.querySelector(".empty")).not.toBeNull();

    // 1 frame: only agents has arrived; old task and delivery projections stay absent.
    handlers.onSnapshot({ "agent-a": agent });
    await tick();
    expect(document.querySelector(".task-ring")).toBeNull();
    document.querySelector<HTMLButtonElement>("button.open")?.click();
    await tick();
    expect(document.querySelector("[data-testid='inter-agent-delivery-status']")).toBeNull();

    // 2 frames: tasks may now appear, while deliveries still remain absent.
    handlers.onTaskSnapshot?.({ "agent-a": { "task-a": taskEnvelope("agent-a") } });
    await tick();
    expect(document.querySelector(".task-ring")).not.toBeNull();
    expect(document.querySelector("[data-testid='inter-agent-delivery-status']")).toBeNull();
  });
});
