import "./isolation.setup";
// @vitest-environment jsdom
// issue #1107: the composer while a send is pending, and what it shows under
// itself afterwards. Each test pins one or more starred cells of the design's
// event x display table: the per-agent lock (Ctrl+Enter included), the
// unconfirmed notice that survives state changes and belongs to its agent,
// at most one notice under the composer, and its lifetime up to the next
// composer submit to that agent.
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import {
  INSTRUCTION_NOT_CONNECTED,
  INSTRUCTION_UNCONFIRMED,
  type Envelope,
  type KaoiroConnection,
} from "../src/lib/protocol";
import { makeReactiveAgentDetailProps } from "./reactiveProps.svelte";

const UNCONFIRMED = "届いたか確かめられませんでした";
const NOT_CONNECTED = "サーバにつながっていないため、送っていません";

const CAPS = {
  session_capabilities: {
    supports_attachments: true,
    supports_user_input_dialog: true,
    supports_session_reset: true,
    session_reset_modes: ["new"],
  },
};

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

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Call = { agentId: string; text: string; reply: Deferred };

function fakeConnection() {
  const sends: Call[] = [];
  const uploads: { agentId: string; reply: Deferred }[] = [];
  const conn = {
    sendInstruction: vi.fn((agentId: string, text: string) => {
      const reply = deferred();
      sends.push({ agentId, text, reply });
      return reply.promise;
    }),
    uploadFile: vi.fn(async (agentId: string) => {
      const reply = deferred();
      uploads.push({ agentId, reply });
      await reply.promise;
      return "upload-1";
    }),
    sendSessionReset: vi.fn(async () => undefined),
  };
  return { conn, sends, uploads };
}

function envelope(agentId: string, state: Envelope["state"] = "tool_running"): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts: "2026-11-14T00:00:00Z",
    type: "state_change",
    state,
    payload: {},
    ext: CAPS,
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

async function render(conn: ReturnType<typeof fakeConnection>["conn"], agentId = "host-a.a") {
  const target = document.createElement("div");
  document.body.append(target);
  const props = makeReactiveAgentDetailProps({
    envelope: envelope(agentId),
    connection: conn as unknown as KaoiroConnection,
    onClose: vi.fn(),
  });
  const component = mount(AgentDetail, { target, props });
  mounted.push(component);
  await settle();
  return { target, props };
}

/** Lets promise chains and the resulting DOM updates finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    flushSync();
  }
}

function textarea(target: HTMLElement): HTMLTextAreaElement {
  return target.querySelector("form.instruct textarea") as HTMLTextAreaElement;
}

function sendButton(target: HTMLElement): HTMLButtonElement {
  return target.querySelector('form.instruct button[type="submit"]') as HTMLButtonElement;
}

async function type(target: HTMLElement, text: string): Promise<void> {
  const area = textarea(target);
  area.value = text;
  area.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

async function ctrlEnter(target: HTMLElement): Promise<void> {
  textarea(target).dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }),
  );
  await settle();
}

async function stageFiles(target: HTMLElement, count: number): Promise<void> {
  const input = target.querySelector('input[type="file"]') as HTMLInputElement;
  const files = Array.from({ length: count }, (_, i) => new File(["x"], `f${i}.txt`, { type: "text/plain" }));
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
}

function notices(target: HTMLElement): HTMLElement[] {
  return [...target.querySelectorAll<HTMLElement>(".composer-notice")];
}

/** Sends `text` to the agent on screen and rejects it as unconfirmed. */
async function leaveUnconfirmed(
  target: HTMLElement,
  harness: ReturnType<typeof fakeConnection>,
  text: string,
): Promise<void> {
  await type(target, text);
  await ctrlEnter(target);
  harness.sends.at(-1)!.reply.reject(new Error(INSTRUCTION_UNCONFIRMED));
  await settle();
}

describe("AgentDetail composer while a send is pending (issue #1107)", () => {
  it("T1: Ctrl+Enter, /new and click are ignored while the agent's send is pending", async () => {
    const harness = fakeConnection();
    const { target } = await render(harness.conn);
    await type(target, "hello");
    await ctrlEnter(target);
    expect(harness.conn.sendInstruction).toHaveBeenCalledTimes(1);
    expect(sendButton(target).disabled).toBe(true);
    expect(sendButton(target).textContent).toBe("送信中…");

    await ctrlEnter(target);
    sendButton(target).click();
    await settle();
    await type(target, "/new");
    await ctrlEnter(target);
    expect(harness.conn.sendInstruction).toHaveBeenCalledTimes(1);
    expect(harness.conn.sendSessionReset).not.toHaveBeenCalled();
  });

  it("T2: an unconfirmed send shows its notice, keeps the text, and survives state changes", async () => {
    const harness = fakeConnection();
    const { target, props } = await render(harness.conn);
    await leaveUnconfirmed(target, harness, "hello");
    expect(notices(target)).toHaveLength(1);
    expect(target.querySelector(".send-unconfirmed")?.textContent).toContain(UNCONFIRMED);
    expect(target.textContent).not.toContain("timeout");
    expect(textarea(target).value).toBe("hello");
    expect(sendButton(target).disabled).toBe(false);

    for (const state of ["thinking", "tool_running", "thinking", "thinking"] as const) {
      props.envelope = envelope("host-a.a", state);
      await settle();
      expect(target.querySelector(".send-unconfirmed")?.textContent).toContain(UNCONFIRMED);
    }
  });

  it("T3: at most one notice — a transient result shows first, then the unconfirmed notice returns", async () => {
    const harness = fakeConnection();
    const { target, props } = await render(harness.conn);
    await leaveUnconfirmed(target, harness, "hello");
    await stageFiles(target, 11);
    expect(notices(target)).toHaveLength(1);
    expect(notices(target)[0]?.classList.contains("action-error")).toBe(true);
    expect(notices(target)[0]?.textContent).not.toContain(UNCONFIRMED);

    props.envelope = envelope("host-a.a", "thinking");
    await settle();
    expect(notices(target)).toHaveLength(1);
    expect(notices(target)[0]?.textContent).toContain(UNCONFIRMED);
  });

  it("T4: the next composer submit to the agent ends the notice (refused reset, and /new)", async () => {
    const refused = fakeConnection();
    const first = await render(refused.conn);
    await leaveUnconfirmed(first.target, refused, "hello");
    await type(first.target, "/clear");
    await ctrlEnter(first.target);
    expect(notices(first.target)).toHaveLength(1);
    expect(notices(first.target)[0]?.textContent).toContain("/clear");
    expect(first.target.querySelector(".send-unconfirmed")).toBeNull();

    const reset = fakeConnection();
    const second = await render(reset.conn, "host-a.c");
    await leaveUnconfirmed(second.target, reset, "hello");
    await type(second.target, "/new");
    await ctrlEnter(second.target);
    expect(reset.conn.sendSessionReset).toHaveBeenCalledWith("host-a.c", "new");
    expect(notices(second.target)).toHaveLength(0);
  });

  it("T5: the lock and the notice belong to the agent the send started on", async () => {
    const harness = fakeConnection();
    const { target, props } = await render(harness.conn);
    await type(target, "to a");
    await ctrlEnter(target);

    props.envelope = envelope("host-a.b");
    await settle();
    expect(sendButton(target).disabled).toBe(false);
    await type(target, "to b");
    await ctrlEnter(target);
    expect(harness.sends.map((c) => c.agentId)).toEqual(["host-a.a", "host-a.b"]);

    harness.sends[0]!.reply.reject(new Error(INSTRUCTION_UNCONFIRMED));
    await settle();
    expect(notices(target)).toHaveLength(0);

    props.envelope = envelope("host-a.a");
    await settle();
    expect(target.querySelector(".send-unconfirmed")?.textContent).toContain(UNCONFIRMED);
    expect(sendButton(target).textContent).toBe("送信");
    await type(target, "to a again");
    await ctrlEnter(target);
    expect(harness.sends.map((c) => c.agentId)).toEqual(["host-a.a", "host-a.b", "host-a.a"]);
  });

  it("T6: not connected is refused with its own message", async () => {
    const harness = fakeConnection();
    const { target } = await render(harness.conn);
    await type(target, "hello");
    await ctrlEnter(target);
    harness.sends[0]!.reply.reject(new Error(INSTRUCTION_NOT_CONNECTED));
    await settle();
    expect(notices(target)).toHaveLength(1);
    expect(target.querySelector(".action-error")?.textContent).toContain(NOT_CONNECTED);
    expect(textarea(target).value).toBe("hello");
  });

  it("T7: an upload failure is not reported as unconfirmed and releases the lock", async () => {
    const harness = fakeConnection();
    const { target } = await render(harness.conn);
    await stageFiles(target, 1);
    await type(target, "with file");
    await ctrlEnter(target);
    await ctrlEnter(target);
    expect(harness.conn.uploadFile).toHaveBeenCalledTimes(1);

    harness.uploads[0]!.reply.reject(new Error("timeout"));
    await settle();
    expect(harness.conn.sendInstruction).not.toHaveBeenCalled();
    expect(target.querySelector(".action-error")?.textContent).toBe("timeout");
    expect(target.querySelector(".send-unconfirmed")).toBeNull();
    expect(sendButton(target).disabled).toBe(false);
  });

  it("T8: control — an ok send clears the composer and shows nothing", async () => {
    const harness = fakeConnection();
    const { target } = await render(harness.conn);
    await type(target, "hello");
    await ctrlEnter(target);
    harness.sends[0]!.reply.resolve();
    await settle();
    expect(textarea(target).value).toBe("");
    expect(notices(target)).toHaveLength(0);
    expect(sendButton(target).textContent).toBe("送信");
  });
});
