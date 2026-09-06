// @vitest-environment jsdom
// issue #305 D (ふじ round 1 S2): the operator gate on the sandbox picker
// lives in App.svelte — `onSetPermission={isOperator && connection ? ... :
// undefined}`. A component test that withholds the prop by hand measures
// AgentDetail's reaction to a withheld prop, not App's decision to
// withhold it. This mounts the real App and lets `onHosts` (the operator
// signal, #22) decide, so removing App's gate has to fail something.
//
// Mirrors appUnackedErrorAck.integration.test.ts's connectKaoiro mock
// harness, which is module-scope and therefore needs its own file.
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
        setPermission: async () => null,
      };
    },
    fetchPersonaManifest: async () => null,
    fetchAuthMethods: async () => ({ token: true, oauth: [] }),
  };
});

const App = (await import("../src/App.svelte")).default;

let component: object | null = null;

/** A Codex session that advertises the permission-switch capability, so
 *  the picker's OTHER gate is satisfied and only the operator one is
 *  under measurement. */
function switchCapableEnvelope(): Envelope {
  return {
    version: "0",
    agent_id: "host-a.p",
    persona: { id: "p", name: "あお", sprite_set: "p" },
    display_name: "あお",
    ts: "2026-09-06T00:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    ext: {
      engine: "codex",
      permission: {
        sandbox: "workspace-write",
        approval: "never",
        enforcement: "os",
      },
      session_capabilities: {
        supports_attachments: false,
        supports_user_input_dialog: true,
        supports_permission_switch: true,
      },
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

async function openDetailFromGrid(): Promise<void> {
  const openButton = document.querySelector<HTMLButtonElement>(
    'button[aria-label$="の詳細を開く"]',
  );
  expect(openButton).not.toBeNull();
  openButton!.click();
  await tick();
}

function rowByLabel(label: string): HTMLElement | null {
  for (const row of document.querySelectorAll(".cc-row")) {
    if (row.querySelector("dt")?.textContent?.trim() === label) {
      return row.querySelector("dd");
    }
  }
  return null;
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

describe("App.svelte sandbox picker operator gate (issue #305 D)", () => {
  it("shows the picker to an operator (onHosts received)", async () => {
    const h = await mountApp();
    h.onHosts?.([], false);
    h.onSnapshot({ "host-a.p": switchCapableEnvelope() });
    await tick();
    await openDetailFromGrid();

    expect(rowByLabel("sandbox 変更")).not.toBeNull();
  });

  it("withholds it from a viewer (no onHosts, so no operator signal)", async () => {
    const h = await mountApp();
    h.onSnapshot({ "host-a.p": switchCapableEnvelope() });
    await tick();
    await openDetailFromGrid();

    // The badge itself still renders — only the control is withheld.
    expect(rowByLabel("実効書込範囲")).not.toBeNull();
    expect(rowByLabel("sandbox 変更")).toBeNull();
  });

  it("withholds it again after a rejoin downgrades the role", async () => {
    // onJoined clears isOperator so a since-revoked operator session
    // cannot keep the control after rejoining as a viewer (the server
    // pushes "hosts" only to an operator-capable role, so a viewer rejoin
    // never re-raises it).
    const h = await mountApp();
    h.onHosts?.([], false);
    h.onSnapshot({ "host-a.p": switchCapableEnvelope() });
    await tick();
    await openDetailFromGrid();
    expect(rowByLabel("sandbox 変更")).not.toBeNull();

    h.onJoined?.();
    h.onSnapshot({ "host-a.p": switchCapableEnvelope() });
    await tick();

    expect(rowByLabel("sandbox 変更")).toBeNull();
  });
});
