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
        setPermission: async () => null,
      };
    },
    fetchPersonaManifest: async () => ({ kind: "unavailable" }),
    fetchAuthMethods: async () => ({ token: true, oauth: [] }),
  };
});

const App = (await import("../src/App.svelte")).default;

let component: object | null = null;

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
      delivery_policy: { policy: "on", revision: 1, applied_revision: 1, confirmed: true, pending: false, wrapper_support: true, mechanisms: { operator_early: "none", inter_agent_early: "steer", inter_agent_yield: "none" } },
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


function policyCheckbox() { return document.querySelector<HTMLInputElement>('.delivery-policy input[type="checkbox"]'); }
async function ready(operator: boolean) {
  const h = await mountApp(); h.onStatus("connected"); h.onJoined?.(); h.onDeliveryPolicyControl?.(true);
  if (operator) h.onHosts?.([], false);
  h.onSnapshot({ "host-a.p": switchCapableEnvelope() }); await tick(); await openDetailFromGrid(); return h;
}
it("operator sees control; a viewer never receives it despite a valid API marker", async () => {
  const h = await ready(true); expect(policyCheckbox()).not.toBeNull();
  h.onJoined?.(); h.onDeliveryPolicyControl?.(true); h.onSnapshot({ "host-a.p": switchCapableEnvelope() }); await tick();
  expect(policyCheckbox()).toBeNull(); expect(document.querySelector('.delivery-policy')?.textContent).toContain("保存設定: on");
});
it("action rechecks role before calling the store even before the old DOM is removed", async () => {
  const { DeliveryPolicyStore } = await import("../src/lib/deliveryPolicyStore.svelte");
  const set = vi.spyOn(DeliveryPolicyStore.prototype, "set").mockResolvedValue();
  const h = await ready(true); const checkbox = policyCheckbox()!;
  h.onJoined?.(); checkbox.checked = false; checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  expect(set).not.toHaveBeenCalled(); await tick(); expect(policyCheckbox()).toBeNull();
});
