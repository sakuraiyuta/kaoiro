import "../isolation.setup";
// Inputs for the AgentDetail engine / kaoiro tab tests (issue 1075). Each
// connected input is built so that, together, they render every one of the
// 19 `dl.cc` row kinds; the rows are engine-exclusive, so no single input can.
import { flushSync, mount, tick, unmount } from "svelte";
import { vi } from "vitest";
import AgentDetail from "../../src/lib/AgentDetail.svelte";
import { DeliveryPolicyStore } from "../../src/lib/deliveryPolicyStore.svelte";
import type { Envelope, KaoiroConnection } from "../../src/lib/protocol";

export type InputName = "I0" | "I1c" | "I1r" | "I1x" | "I1u" | "I1g" | "I2" | "I3";

export const INPUT_NAMES: InputName[] = ["I0", "I1c", "I1r", "I1x", "I1u", "I1g", "I2", "I3"];

export function connection(): KaoiroConnection {
  return {
    spawn: vi.fn(),
    enumerateAgentSessions: vi.fn(async () => undefined),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    setPermission: vi.fn(),
    refreshModels: vi.fn(async () => ({
      agent_id: "host-a.p",
      request_id: "test",
      ok: true,
      models_count: 0,
    })),
    refreshEngineCatalog: vi.fn(),
  } as unknown as KaoiroConnection;
}

export function envelope(
  ext: Record<string, unknown> | undefined,
  state = "idle",
  agentId = "host-a.p",
): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts: "2026-11-11T00:00:00Z",
    type: "state_change",
    state,
    payload: {},
    ...(ext === undefined ? {} : { ext }),
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

const SWITCH_CAPS = {
  supports_attachments: false,
  supports_user_input_dialog: true,
  supports_permission_switch: true,
  permission_switch_axes: {
    sandbox: { max: "danger-full-access" },
    network_access: { max: true },
    approval: { max: "never" },
  },
};

const CLAUDE_EXT = {
  engine: "claude-code",
  model: "claude-opus-5-5",
  effort: "high",
  cwd: "/w/repo",
  permission_mode: "default",
  fast_mode: "on",
  models_error: true,
  resume_drift: [{ field: "model", prev: "a", now: "b" }],
  session_capabilities: {
    supports_attachments: true,
    supports_user_input_dialog: true,
    supports_permission_mode_switch: true,
  },
};

const CODEX_AXES_EXT = {
  engine: "codex",
  permission: { sandbox: "workspace-write", approval: "never", enforcement: "os" },
  effective: { sandbox: "workspace-write", network_access: false },
  session_capabilities: SWITCH_CAPS,
  permission_control: {
    revision: 7,
    requested: { sandbox: "workspace-write", network_access: false },
    constraints: { approval: "never", enforcement: "os" },
    status: "pending",
  },
};

const CONTROL_UNKNOWN_EXT = {
  engine: "codex",
  session_capabilities: SWITCH_CAPS,
  permission_control: {
    revision: 7,
    requested: { sandbox: "workspace-write", network_access: false },
    constraints: { approval: "never", enforcement: "os" },
    status: "unknown",
    submitted: {
      revision: 7,
      requested: { sandbox: "workspace-write", network_access: false },
      execution_id: "exec-7",
    },
    reason: "observation_unavailable",
    last_effective: {
      revision: 2,
      requested: { sandbox: "read-only", network_access: true },
      execution_id: "exec-2",
      session_id: "session-a",
      turn_id: "turn-2",
      permission: { sandbox: "read-only", approval: "never", enforcement: "os" },
      network_access: true,
    },
  },
};

const GROK_EXT = {
  engine: "grok",
  permission_policy: { mode: "default", rules: [] },
  effective: { sandbox: "workspace-write", network_access: true },
  session_capabilities: {
    supports_permission_switch: false,
    supports_user_input_dialog: true,
    supports_attachments: false,
  },
};

function policyStore(): DeliveryPolicyStore {
  const access = {
    operator: true,
    connected: true,
    connection: {
      setDeliveryPolicy: vi.fn(),
      getDeliveryPolicy: vi.fn(),
    } as unknown as KaoiroConnection,
  };
  const store = new DeliveryPolicyStore(() => access);
  store.available = true;
  return store;
}

/** Everything a kaoiro panel can show, for the inputs that turn rows on. */
function kaoiroExtras(): Record<string, unknown> {
  return {
    policyStore: policyStore(),
    policyConnected: true,
    onOpenSessionLifecycle: vi.fn(),
    deliveryStatus: { issued_seq: 3, acked_seq: 2, lost_count: 0, uncertain_count: 1 },
    wrapperBuildInfo: {
      build_version: "2026.11.11.1",
      build_channel: "dev",
      build_revision: "1234567890abcdef1234567890abcdef12345678",
      build_dirty: false,
      build_branch: "issue-1075",
    },
  };
}

export function inputProps(name: InputName): Record<string, unknown> {
  const base = { onClose: vi.fn() };
  switch (name) {
    case "I0":
      return { ...base, envelope: envelope(undefined), connection: connection() };
    case "I1c":
      return {
        ...base,
        ...kaoiroExtras(),
        envelope: envelope(CLAUDE_EXT),
        connection: connection(),
      };
    case "I1r":
      return {
        ...base,
        ...kaoiroExtras(),
        envelope: envelope(CLAUDE_EXT, "thinking"),
        connection: connection(),
      };
    case "I1x":
      return {
        ...base,
        envelope: envelope(CODEX_AXES_EXT),
        connection: connection(),
        onSetPermission: vi.fn(async () => {
          throw new Error("forbidden");
        }),
      };
    case "I1u":
      return {
        ...base,
        envelope: envelope(CONTROL_UNKNOWN_EXT),
        connection: connection(),
        onSetPermission: vi.fn(async () => null),
      };
    case "I1g":
      return { ...base, envelope: envelope(GROK_EXT), connection: connection() };
    case "I2":
      return {
        ...base,
        ...kaoiroExtras(),
        envelope: envelope(CLAUDE_EXT, "disconnected"),
        connection: connection(),
      };
    case "I3":
      return {
        ...base,
        ...kaoiroExtras(),
        envelope: envelope(CLAUDE_EXT),
        connection: null,
      };
  }
}

function rowByLabel(target: HTMLElement, label: string): HTMLElement | null {
  for (const row of target.querySelectorAll<HTMLElement>(".cc-row")) {
    if (row.querySelector("dt")?.textContent?.trim() === label) return row;
  }
  return null;
}

/** I1x: a rejected sandbox request turns the permission request error on. */
async function failSandboxRequest(target: HTMLElement): Promise<void> {
  const row = rowByLabel(target, "sandbox 変更");
  if (row === null) throw new Error("I1x: no sandbox picker");
  (row.querySelector(".cc-perm-switch") as HTMLButtonElement).click();
  await tick();
  const option = [...row.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    (o) => o.textContent?.trim() === "read-only",
  );
  if (option === undefined) throw new Error("I1x: no read-only option");
  option.click();
  await tick();
  await tick();
}

export interface Rendered {
  target: HTMLElement;
  component: object;
}

export async function renderInput(name: InputName): Promise<Rendered> {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AgentDetail, { target, props: inputProps(name) as never });
  await tick();
  flushSync();
  if (name === "I1x") await failSandboxRequest(target);
  return { target, component };
}

export async function unmountAll(rendered: Rendered[]): Promise<void> {
  for (const r of rendered.splice(0)) await unmount(r.component);
  document.body.innerHTML = "";
}

/** Marker selectors of the items outside `dl.cc`. */
export const ITEM_SELECTORS = [
  ".session-lifecycle-open",
  ".delivery-policy",
  ".clear-history",
  ".resume-swap",
  ".terminate",
  ".restore",
  ".interrupt",
  ".remove",
] as const;

/** Every `dt` text and every marker item, in document order. */
export function itemSet(target: HTMLElement): string[] {
  const dts = [...target.querySelectorAll("dt")].map((dt) => `dt:${dt.textContent?.trim() ?? ""}`);
  const items = ITEM_SELECTORS.flatMap((sel) =>
    [...target.querySelectorAll(sel)].map(() => `item:${sel}`),
  );
  return [...dts, ...items];
}
