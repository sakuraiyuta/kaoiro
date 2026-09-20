// @vitest-environment jsdom
// issue #381: an exact `/new`・`/clear` (no attachments) on a session that
// has not advertised session_reset support for that mode must not fall
// through as an ordinary instruction — the server would reject it with the
// raw `reserved_session_command` reason (agents_channel.ex), which used to
// surface verbatim via actionError. The composer must show a message and
// send nothing instead.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import type { Envelope, KaoiroConnection } from "../src/lib/protocol";

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

function connection(overrides: Partial<KaoiroConnection> = {}): KaoiroConnection {
  return {
    sendInstruction: vi.fn(async () => undefined),
    sendSessionReset: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as KaoiroConnection;
}

function envelope(ext: Record<string, unknown>): Envelope {
  return {
    version: "0",
    agent_id: "host-a.p",
    ts: "2026-09-21T00:00:00Z",
    type: "state_change",
    state: "waiting_input",
    payload: {},
    ext,
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

async function render(ext: Record<string, unknown>, conn: KaoiroConnection) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AgentDetail, {
    target,
    props: { envelope: envelope(ext), connection: conn, onClose: vi.fn() },
  });
  mounted.push(component);
  await tick();
  return target;
}

async function submitInstruction(target: HTMLElement, text: string): Promise<void> {
  const textarea = target.querySelector("form.instruct textarea") as HTMLTextAreaElement;
  textarea.value = text;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  target
    .querySelector("form.instruct")!
    .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  await tick();
}

describe("AgentDetail session reset unsupported guard (issue #381)", () => {
  it("capability 未 stamp: /clear は送信されず案内が出る", async () => {
    const conn = connection();
    const target = await render(
      { session_capabilities: { supports_attachments: true, supports_user_input_dialog: true } },
      conn,
    );
    await submitInstruction(target, "/clear");
    expect(conn.sendInstruction).not.toHaveBeenCalled();
    expect(conn.sendSessionReset).not.toHaveBeenCalled();
    expect(target.querySelector(".action-error")?.textContent).toContain("/clear");
  });

  it("conditional-off (mode が session_reset_modes に無い): /clear は送信されず案内が出る", async () => {
    const conn = connection();
    const target = await render(
      {
        session_capabilities: {
          supports_attachments: true,
          supports_user_input_dialog: true,
          supports_session_reset: true,
          session_reset_modes: ["new"],
        },
      },
      conn,
    );
    await submitInstruction(target, "/clear");
    expect(conn.sendInstruction).not.toHaveBeenCalled();
    expect(conn.sendSessionReset).not.toHaveBeenCalled();
    expect(target.querySelector(".action-error")?.textContent).toContain("/clear");
  });

  it("negative control: capability 有り (Claude/Codex/Antigravity 共通) は sendSessionReset が呼ばれ案内は出ない", async () => {
    const conn = connection();
    const target = await render(
      {
        session_capabilities: {
          supports_attachments: true,
          supports_user_input_dialog: true,
          supports_session_reset: true,
          session_reset_modes: ["new", "clear"],
        },
      },
      conn,
    );
    await submitInstruction(target, "/clear");
    expect(conn.sendSessionReset).toHaveBeenCalledWith("host-a.p", "clear");
    expect(conn.sendInstruction).not.toHaveBeenCalled();
    expect(target.querySelector(".action-error")).toBeNull();
  });
});
