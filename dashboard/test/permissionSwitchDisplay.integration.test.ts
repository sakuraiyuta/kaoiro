// @vitest-environment jsdom
// issue #305 D: the Codex sandbox / network_access control and the
// permission_control state display in AgentDetail.
//
// Two invariants drive most of these cases. (1) Nothing here promotes an
// EFFECTIVE value: an ack confirms a saved request only, so the badge
// keeps showing observed values and shows "未確認" when there is no
// observation — never an invented default. (2) The picker is gated on the
// capability AND on the operator-only prop, so a viewer sees no control
// even if a future change stops stripping ext for viewers.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import { makeReactivePermissionDetailProps } from "./reactiveProps.svelte";
import { permissionControlFrom } from "../src/lib/protocol";
import type {
  Envelope,
  KaoiroConnection,
  SetPermissionAck,
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

function connection(): KaoiroConnection {
  return {
    spawn: vi.fn(),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    setPermission: vi.fn(),
  } as unknown as KaoiroConnection;
}

function envelope(
  ext: Record<string, unknown>,
  state = "idle",
  agentId = "host-a.p",
): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts: "2026-09-06T00:00:00Z",
    type: "state_change",
    state,
    payload: {},
    ext,
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

/** Capability stamp a Codex session sends once the permission contract is
 *  wired end to end (wrapper/codex initialStatusExt). */
const SWITCH_CAPS = {
  supports_attachments: false,
  supports_user_input_dialog: true,
  supports_permission_switch: true,
};

function control(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revision: 7,
    requested: { sandbox: "workspace-write", network_access: false },
    constraints: { approval: "never", enforcement: "os" },
    status: "pending",
    ...over,
  };
}

/** A COMPLETE `applied` record. The contract requires both `submitted`
 *  and `effective`, matching on revision, requested pair and execution_id
 *  — an `applied` without them claims an observation nothing observed.
 *  (Introduced by ふじ's round-1 boundary probes; hoisted here so the
 *  status-line fixtures below stop encoding the unbacked shape.) */
function observedControl(revision: number): Record<string, unknown> {
  const requested = { sandbox: "workspace-write", network_access: false };
  const submitted = { revision, requested, execution_id: `exec-${revision}` };
  return control({
    revision,
    requested,
    status: "applied",
    submitted,
    effective: {
      ...submitted,
      session_id: "session-a",
      turn_id: `turn-${revision}`,
      permission: {
        sandbox: "workspace-write",
        approval: "never",
        enforcement: "os",
      },
      network_access: false,
    },
  });
}

/** A record that satisfies the `PermissionControlExt` arm for `status`.
 *  Each arm requires different fields, so `control({ status })` is a valid
 *  positive fixture for `pending` alone — using it everywhere is what let
 *  an unbacked `applied` and a reasonless `unknown` stand as normal
 *  examples (ふじ round 1 M2). */
function conformingControl(status: string): Record<string, unknown> {
  const revision = 7;
  const requested = { sandbox: "workspace-write", network_access: false };
  const submitted = { revision, requested, execution_id: `exec-${revision}` };
  switch (status) {
    case "applying":
      return control({ status, submitted });
    case "applied":
      return observedControl(revision);
    case "failed":
      return control({ status, reason: "observation_unavailable" });
    case "unknown":
      return control({ status, submitted, reason: "observation_unavailable" });
    default:
      return control({ status });
  }
}

function rowByLabel(target: HTMLElement, label: string): HTMLElement | null {
  for (const row of target.querySelectorAll(".cc-row")) {
    if (row.querySelector("dt")?.textContent?.trim() === label) {
      return row.querySelector("dd");
    }
  }
  return null;
}

async function render(
  ext: Record<string, unknown>,
  options: {
    onSetPermission?:
      | ReturnType<typeof vi.fn>
      | undefined;
    state?: string;
  } = {},
) {
  const target = document.createElement("div");
  document.body.append(target);
  const onSetPermission =
    "onSetPermission" in options
      ? options.onSetPermission
      : vi.fn(async () => null);
  const props = makeReactivePermissionDetailProps({
    envelope: envelope(ext, options.state ?? "idle"),
    connection: connection(),
    onClose: vi.fn(),
    onSetPermission: onSetPermission as never,
  });
  const component = mount(AgentDetail, { target, props });
  mounted.push(component);
  await tick();
  return { target, props, onSetPermission };
}

describe("AgentDetail sandbox / network control (issue #305 D)", () => {
  it("shows the sandbox picker with both the capability and the operator prop", async () => {
    const { target } = await render({
      engine: "codex",
      session_capabilities: SWITCH_CAPS,
      permission_control: control(),
    });
    expect(rowByLabel(target, "sandbox 変更")).not.toBeNull();
  });

  it("hides the picker from a viewer (operator prop withheld)", async () => {
    // The two-layer gate: even with the capability stamped and a control
    // record present, withholding the operator-only prop must hide the
    // control. App.svelte withholds it on `isOperator`, so this pins the
    // component half without depending on ext stripping.
    const { target } = await render(
      {
        engine: "codex",
        session_capabilities: SWITCH_CAPS,
        permission_control: control(),
      },
      { onSetPermission: undefined },
    );
    expect(rowByLabel(target, "sandbox 変更")).toBeNull();
    expect(rowByLabel(target, "network 変更")).toBeNull();
    expect(rowByLabel(target, "権限要求")).toBeNull();
  });

  it("hides the picker when the capability is unstamped (fail-closed)", async () => {
    const { target } = await render({
      engine: "codex",
      permission_control: control(),
    });
    expect(rowByLabel(target, "sandbox 変更")).toBeNull();
  });

  it("stays usable while busy and sends the patch for the next execution", async () => {
    const { target, onSetPermission } = await render(
      {
        engine: "codex",
        session_capabilities: SWITCH_CAPS,
        permission_control: control(),
      },
      { state: "thinking" },
    );
    const dd = rowByLabel(target, "sandbox 変更");
    expect(dd).not.toBeNull();
    (dd?.querySelector(".cc-perm-switch") as HTMLButtonElement).click();
    await tick();
    const options = dd?.querySelectorAll('[role="option"]') ?? [];
    const danger = Array.from(options).find(
      (o) => o.textContent?.trim() === "danger-full-access",
    ) as HTMLButtonElement;
    danger.click();
    await tick();
    expect(onSetPermission).toHaveBeenCalledWith("host-a.p", {
      sandbox: "danger-full-access",
    });
  });

  it("offers the network toggle only for workspace-write", async () => {
    const { target } = await render({
      engine: "codex",
      session_capabilities: SWITCH_CAPS,
      permission_control: control(),
    });
    expect(rowByLabel(target, "network 変更")).not.toBeNull();

    const readOnly = await render({
      engine: "codex",
      session_capabilities: SWITCH_CAPS,
      permission_control: control({
        requested: { sandbox: "read-only", network_access: false },
      }),
    });
    expect(rowByLabel(readOnly.target, "network 変更")).toBeNull();
  });

  it.each([
    ["pending", "要求済み"],
    ["applying", "適用中"],
    ["applied", "適用済み"],
    ["failed", "失敗"],
    ["unknown", "未確認"],
  ])("renders status=%s as its own distinct state line", async (status, label) => {
    const { target } = await render({
      engine: "codex",
      session_capabilities: SWITCH_CAPS,
      permission_control: conformingControl(status),
    });
    const dd = rowByLabel(target, "権限要求");
    expect(dd?.textContent).toContain("rev 7");
    expect(dd?.textContent).toContain(label);
  });

  it("shows reason and rolled_back_to when the request failed", async () => {
    const { target } = await render({
      engine: "codex",
      session_capabilities: SWITCH_CAPS,
      permission_control: control({
        status: "failed",
        reason: "observation_unavailable",
        rolled_back_to: { sandbox: "read-only", network_access: false },
      }),
    });
    const dd = rowByLabel(target, "権限要求");
    expect(dd?.textContent).toContain("失敗");
    expect(dd?.textContent).toContain("observation_unavailable");
    expect(dd?.textContent).toContain("適用前に戻した設定");
    expect(dd?.textContent).toContain("read-only");
  });

  it("keeps the network_access row and marks it unknown before any observation", async () => {
    const { target } = await render({
      engine: "codex",
      session_capabilities: SWITCH_CAPS,
      permission_control: control(),
    });
    expect(rowByLabel(target, "network_access")?.textContent?.trim()).toBe(
      "未確認",
    );
  });

  it("renders the fixed approval from constraints even without ext.permission", async () => {
    // The sandbox is genuinely unobserved, but approval being host-fixed
    // to "never" is a configured contract value that needs no observation
    // — dropping it with the rest would hide a certain fact.
    const { target } = await render({
      engine: "codex",
      session_capabilities: SWITCH_CAPS,
      permission_control: control(),
    });
    const dd = rowByLabel(target, "実効書込範囲");
    expect(dd?.textContent).toContain("書込: 未確認");
    expect(dd?.textContent).toContain("承認: never");
    expect(dd?.textContent).toContain("host-fixed");
  });

  it("renders the ack revision until a newer control replaces it", async () => {
    const ack: SetPermissionAck = {
      revision: 5,
      status: "pending",
      requested: { sandbox: "read-only", network_access: false },
    };
    const { target, props } = await render(
      { engine: "codex", session_capabilities: SWITCH_CAPS },
      { onSetPermission: vi.fn(async () => ack) },
    );
    const dd = () => rowByLabel(target, "sandbox 変更");
    (dd()?.querySelector(".cc-perm-switch") as HTMLButtonElement).click();
    await tick();
    const option = Array.from(
      dd()?.querySelectorAll('[role="option"]') ?? [],
    ).find((o) => o.textContent?.trim() === "read-only") as HTMLButtonElement;
    option.click();
    await tick();
    await tick();
    expect(rowByLabel(target, "権限要求")?.textContent).toContain("rev 5");

    props.envelope = envelope({
      engine: "codex",
      session_capabilities: SWITCH_CAPS,
      permission_control: control({
        revision: 6,
        status: "applying",
        submitted: {
          revision: 6,
          requested: { sandbox: "workspace-write", network_access: false },
          execution_id: "exec-6",
        },
      }),
    });
    await tick();
    expect(rowByLabel(target, "権限要求")?.textContent).toContain("rev 6");
    expect(rowByLabel(target, "権限要求")?.textContent).toContain("適用中");
  });

  it("does not let an older control roll the display back", async () => {
    const ack: SetPermissionAck = {
      revision: 9,
      status: "pending",
      requested: { sandbox: "read-only", network_access: false },
    };
    const { target, props } = await render(
      { engine: "codex", session_capabilities: SWITCH_CAPS },
      { onSetPermission: vi.fn(async () => ack) },
    );
    const dd = () => rowByLabel(target, "sandbox 変更");
    (dd()?.querySelector(".cc-perm-switch") as HTMLButtonElement).click();
    await tick();
    const option = Array.from(
      dd()?.querySelectorAll('[role="option"]') ?? [],
    ).find((o) => o.textContent?.trim() === "read-only") as HTMLButtonElement;
    option.click();
    await tick();
    await tick();

    props.envelope = envelope({
      engine: "codex",
      session_capabilities: SWITCH_CAPS,
      permission_control: control({ revision: 4 }),
    });
    await tick();
    expect(rowByLabel(target, "権限要求")?.textContent).toContain("rev 9");
  });

  it("drops a settled ack so it cannot resurface once control goes away", async () => {
    // Without clearing the ack after its own revision settles, an envelope
    // that later carries no permission_control (a reconnect frame, or a
    // server that stops projecting) would fall back to the ack and render
    // a long-finished request as still pending.
    const ack: SetPermissionAck = {
      revision: 5,
      status: "pending",
      requested: { sandbox: "read-only", network_access: false },
    };
    const { target, props } = await render(
      { engine: "codex", session_capabilities: SWITCH_CAPS },
      { onSetPermission: vi.fn(async () => ack) },
    );
    const dd = () => rowByLabel(target, "sandbox 変更");
    (dd()?.querySelector(".cc-perm-switch") as HTMLButtonElement).click();
    await tick();
    const option = Array.from(
      dd()?.querySelectorAll('[role="option"]') ?? [],
    ).find((o) => o.textContent?.trim() === "read-only") as HTMLButtonElement;
    option.click();
    await tick();
    await tick();
    expect(rowByLabel(target, "権限要求")?.textContent).toContain("rev 5");

    props.envelope = envelope({
      engine: "codex",
      session_capabilities: SWITCH_CAPS,
      permission_control: observedControl(6),
    });
    await tick();
    props.envelope = envelope({
      engine: "codex",
      session_capabilities: SWITCH_CAPS,
    });
    await tick();
    expect(rowByLabel(target, "権限要求")).toBeNull();
  });

  it("clears the request line and the error when the detail switches agent", async () => {
    // AgentDetail is reused across agents rather than re-keyed, so local
    // request state has to be dropped on the switch — otherwise one
    // agent's pending revision and error text render under another's
    // controls.
    const ack: SetPermissionAck = {
      revision: 5,
      status: "pending",
      requested: { sandbox: "read-only", network_access: false },
    };
    const { target, props } = await render(
      { engine: "codex", session_capabilities: SWITCH_CAPS },
      { onSetPermission: vi.fn(async () => ack) },
    );
    const dd = () => rowByLabel(target, "sandbox 変更");
    (dd()?.querySelector(".cc-perm-switch") as HTMLButtonElement).click();
    await tick();
    const option = Array.from(
      dd()?.querySelectorAll('[role="option"]') ?? [],
    ).find((o) => o.textContent?.trim() === "read-only") as HTMLButtonElement;
    option.click();
    await tick();
    await tick();
    expect(rowByLabel(target, "権限要求")?.textContent).toContain("rev 5");

    props.envelope = envelope(
      { engine: "codex", session_capabilities: SWITCH_CAPS },
      "idle",
      "host-b.p",
    );
    await tick();
    expect(rowByLabel(target, "権限要求")).toBeNull();
  });

  it("ignores a reply that lands after the detail switched agent", async () => {
    // Clearing the state on switch is not enough while a reply is still in
    // flight: the continuation resumes into a view showing another agent.
    // Revisions are per-agent, so a leaked ack would also outrank the new
    // agent's own control and suppress its real state.
    let resolveAck: (value: SetPermissionAck | null) => void = () => {};
    const pending = new Promise<SetPermissionAck | null>((resolve) => {
      resolveAck = resolve;
    });
    const { target, props } = await render(
      { engine: "codex", session_capabilities: SWITCH_CAPS },
      { onSetPermission: vi.fn(() => pending) },
    );
    const dd = () => rowByLabel(target, "sandbox 変更");
    (dd()?.querySelector(".cc-perm-switch") as HTMLButtonElement).click();
    await tick();
    const option = Array.from(
      dd()?.querySelectorAll('[role="option"]') ?? [],
    ).find((o) => o.textContent?.trim() === "read-only") as HTMLButtonElement;
    option.click();
    await tick();

    props.envelope = envelope(
      {
        engine: "codex",
        session_capabilities: SWITCH_CAPS,
        permission_control: control({
          revision: 2,
          requested: { sandbox: "read-only", network_access: false },
        }),
      },
      "idle",
      "host-b.p",
    );
    await tick();
    resolveAck({
      revision: 42,
      status: "pending",
      requested: { sandbox: "danger-full-access", network_access: false },
    });
    await tick();
    await tick();
    const row = rowByLabel(target, "権限要求");
    expect(row?.textContent).toContain("rev 2");
    expect(row?.textContent).not.toContain("rev 42");
    expect(row?.textContent).not.toContain("danger-full-access");
  });

  it("ignores a rejection that lands after the detail switched agent", async () => {
    let rejectAck: (reason: unknown) => void = () => {};
    const pending = new Promise<SetPermissionAck | null>((_resolve, reject) => {
      rejectAck = reject;
    });
    const { target, props } = await render(
      { engine: "codex", session_capabilities: SWITCH_CAPS },
      { onSetPermission: vi.fn(() => pending) },
    );
    const dd = () => rowByLabel(target, "sandbox 変更");
    (dd()?.querySelector(".cc-perm-switch") as HTMLButtonElement).click();
    await tick();
    const option = Array.from(
      dd()?.querySelectorAll('[role="option"]') ?? [],
    ).find((o) => o.textContent?.trim() === "read-only") as HTMLButtonElement;
    option.click();
    await tick();

    props.envelope = envelope(
      { engine: "codex", session_capabilities: SWITCH_CAPS },
      "idle",
      "host-b.p",
    );
    await tick();
    rejectAck(new Error("forbidden"));
    await tick();
    await tick();
    expect(rowByLabel(target, "権限要求エラー")).toBeNull();
  });

  it("does not let a slower ack overwrite a newer one", async () => {
    // The control stays usable while a request is in flight, so two
    // patches can be outstanding at once; the older reply must not roll
    // the displayed revision back.
    const acks: SetPermissionAck[] = [
      {
        revision: 9,
        status: "pending",
        requested: { sandbox: "read-only", network_access: false },
      },
      {
        revision: 3,
        status: "pending",
        requested: { sandbox: "danger-full-access", network_access: false },
      },
    ];
    let call = 0;
    const { target } = await render(
      { engine: "codex", session_capabilities: SWITCH_CAPS },
      { onSetPermission: vi.fn(async () => acks[call++]!) },
    );
    const dd = () => rowByLabel(target, "sandbox 変更");
    const pick = async (value: string) => {
      (dd()?.querySelector(".cc-perm-switch") as HTMLButtonElement).click();
      await tick();
      const option = Array.from(
        dd()?.querySelectorAll('[role="option"]') ?? [],
      ).find((o) => o.textContent?.trim() === value) as HTMLButtonElement;
      option.click();
      await tick();
      await tick();
    };
    await pick("read-only");
    expect(rowByLabel(target, "権限要求")?.textContent).toContain("rev 9");
    await pick("danger-full-access");
    expect(rowByLabel(target, "権限要求")?.textContent).toContain("rev 9");
  });

  it("maps a rejection reason to UI text and shows an unmapped one raw", async () => {
    const { target } = await render(
      { engine: "codex", session_capabilities: SWITCH_CAPS },
      {
        onSetPermission: vi.fn(async () => {
          throw new Error("forbidden");
        }),
      },
    );
    const dd = () => rowByLabel(target, "sandbox 変更");
    (dd()?.querySelector(".cc-perm-switch") as HTMLButtonElement).click();
    await tick();
    const option = Array.from(
      dd()?.querySelectorAll('[role="option"]') ?? [],
    ).find((o) => o.textContent?.trim() === "read-only") as HTMLButtonElement;
    option.click();
    await tick();
    await tick();
    expect(rowByLabel(target, "権限要求エラー")?.textContent).toContain(
      "operator のみ",
    );

    const unknown = await render(
      { engine: "codex", session_capabilities: SWITCH_CAPS },
      {
        onSetPermission: vi.fn(async () => {
          throw new Error("some_future_reason");
        }),
      },
    );
    const dd2 = () => rowByLabel(unknown.target, "sandbox 変更");
    (dd2()?.querySelector(".cc-perm-switch") as HTMLButtonElement).click();
    await tick();
    const option2 = Array.from(
      dd2()?.querySelectorAll('[role="option"]') ?? [],
    ).find((o) => o.textContent?.trim() === "read-only") as HTMLButtonElement;
    option2.click();
    await tick();
    await tick();
    expect(
      rowByLabel(unknown.target, "権限要求エラー")?.textContent,
    ).toContain("some_future_reason");
  });
});

describe("permissionControlFrom (issue #305 D)", () => {
  it("reads a well-formed control", () => {
    expect(
      permissionControlFrom(envelope({ permission_control: control() })),
    ).toMatchObject({ revision: 7, status: "pending" });
  });

  it.each([
    ["a non-integer revision", { revision: 1.5 }],
    ["a non-numeric revision", { revision: "7" }],
    ["an unknown status", { status: "queued" }],
    ["a missing requested pair", { requested: undefined }],
    ["a non-boolean requested.network_access", {
      requested: { sandbox: "read-only", network_access: "no" },
    }],
    ["missing constraints", { constraints: undefined }],
    ["an unknown constraints.enforcement", {
      constraints: { approval: "never", enforcement: "kernel" },
    }],
  ])("returns null fail-closed for %s", (_label, over) => {
    // A partial record is dropped whole: every field here drives a
    // permission badge, so rendering half of one would claim a posture
    // the wrapper never reported.
    expect(
      permissionControlFrom(envelope({ permission_control: control(over) })),
    ).toBeNull();
  });
});

describe("AgentDetail Claude mode picker gating (issue #305 D)", () => {
  it("shows the picker on the capability alone and labels an unreported mode unknown", async () => {
    const { target } = await render({
      engine: "claude-code",
      session_capabilities: {
        supports_attachments: false,
        supports_user_input_dialog: true,
        supports_permission_mode_switch: true,
      },
    });
    const dd = rowByLabel(target, "作業意図");
    expect(dd).not.toBeNull();
    expect(dd?.textContent).toContain("未確認");
    expect(dd?.textContent).not.toContain("default");
  });

  it("hides the picker without either the capability or mode metadata", async () => {
    // The removed fail-open default: absent permission data used to mean
    // "switchable", which showed Claude's six-mode picker on a Codex agent
    // whose sandbox was not yet observed — a control set_permission_mode
    // rejects.
    const { target } = await render({ engine: "claude-code" });
    expect(rowByLabel(target, "作業意図")).toBeNull();
  });

  it("falls back to legacy mode metadata when the capability is absent (rolling upgrade)", async () => {
    const { target } = await render({
      engine: "claude-code",
      permission_mode: "acceptEdits",
    });
    expect(rowByLabel(target, "作業意図")).not.toBeNull();
  });

  it("hides it for a contrary enforcement even with the capability", async () => {
    const { target } = await render({
      engine: "codex",
      session_capabilities: {
        supports_attachments: false,
        supports_user_input_dialog: true,
        supports_permission_mode_switch: true,
      },
      permission: { sandbox: "read-only", approval: "never", enforcement: "os" },
    });
    expect(rowByLabel(target, "作業意図")).toBeNull();
  });
});

// Independent review boundary probes; state inputs are valid wire controls unless named malformed.
async function reviewPick(target: HTMLElement) {
  const dd = rowByLabel(target, "sandbox 変更")!;
  (dd.querySelector(".cc-perm-switch") as HTMLButtonElement).click();
  await tick();
  (dd.querySelector('[role="option"]') as HTMLButtonElement).click();
  await tick();
}
const reviewExt = (pc?: Record<string, unknown>) => ({ engine: "codex",
  session_capabilities: SWITCH_CAPS, ...(pc === undefined ? {} : { permission_control: pc }) });

describe("Fuji independent permission boundaries", () => {
  it("does not resurrect an ack delivered after its applied push disappeared", async () => {
    let resolve!: (value: SetPermissionAck) => void;
    const reply = new Promise<SetPermissionAck>(r => { resolve = r; });
    const { target, props } = await render(reviewExt(), { onSetPermission: vi.fn(() => reply) });
    await reviewPick(target);
    props.envelope = envelope(reviewExt(observedControl(9)));
    await tick();
    resolve({ revision: 9, status: "pending", requested: { sandbox: "workspace-write", network_access: false } });
    await tick(); await tick();
    expect(rowByLabel(target, "権限要求")?.textContent).toContain("適用済み");
    props.envelope = envelope(reviewExt());
    await tick();
    expect(rowByLabel(target, "権限要求")).toBeNull();
  });
  it("keeps the latest known revision after a settled ack is cleared", async () => {
    const { target, props } = await render(reviewExt(), { onSetPermission: vi.fn(async () => ({
      revision: 9, status: "pending", requested: { sandbox: "workspace-write", network_access: false }
    })) });
    await reviewPick(target); await tick();
    props.envelope = envelope(reviewExt(observedControl(9)));
    await tick();
    expect(rowByLabel(target, "権限要求")?.textContent).toContain("適用済み");
    props.envelope = envelope(reviewExt(control({ revision: 4 })));
    await tick();
    expect(rowByLabel(target, "権限要求")?.textContent ?? "").not.toContain("rev 4");
  });
  it("does not let push-only updates reduce the latest known revision", async () => {
    const { target, props } = await render(reviewExt(observedControl(9)));
    props.envelope = envelope(reviewExt(control({ revision: 4 })));
    await tick();
    expect(rowByLabel(target, "権限要求")?.textContent ?? "").not.toContain("rev 4");
  });
  it("accepts the complete applied observation as a positive parse control", () => {
    expect(permissionControlFrom(envelope(reviewExt(observedControl(9))))?.status).toBe("applied");
  });
  it("rejects applied without submitted or observed evidence", () => {
    expect(permissionControlFrom(envelope(reviewExt(control({ status: "applied" }))))).toBeNull();
  });
  it("rejects applied whose effective is only a copy of the submission", () => {
    // The engine identities are what make `effective` an OBSERVATION.
    // Without them the record repeats the submission, and "適用済み" would
    // rest on the wrapper having asked rather than on anything observed.
    const requested = { sandbox: "workspace-write", network_access: false };
    const submitted = { revision: 9, requested, execution_id: "exec-9" };
    const pc = control({
      revision: 9,
      requested,
      status: "applied",
      submitted,
      effective: { ...submitted },
    });
    expect(permissionControlFrom(envelope(reviewExt(pc)))).toBeNull();
  });

  it("rejects applied whose evidence describes another execution", () => {
    // "matching revision, requested pair, and execution_id" — a submission
    // and an observation that disagree describe two different execs, and
    // the contract warns that a predecessor's result cannot settle the
    // current request.
    const pc = observedControl(9) as Record<string, Record<string, unknown>>;
    const mismatched = {
      ...pc,
      effective: { ...pc.effective, execution_id: "exec-8" },
    };
    expect(permissionControlFrom(envelope(reviewExt(mismatched)))).toBeNull();
  });

  it("rejects applied whose evidence belongs to an earlier revision", () => {
    // A predecessor's observation cannot settle the current request: "A's
    // eventual result cannot settle or erase B." Without this the badge
    // would read "rev 10 適用済み" on evidence for rev 9.
    const pc = { ...observedControl(9), revision: 10 };
    expect(permissionControlFrom(envelope(reviewExt(pc)))).toBeNull();
  });

  it("rejects applied whose evidence carries a different requested pair", () => {
    const pc = observedControl(9) as Record<string, Record<string, unknown>>;
    const mismatched = {
      ...pc,
      submitted: {
        ...pc.submitted,
        requested: { sandbox: "read-only", network_access: false },
      },
    };
    expect(permissionControlFrom(envelope(reviewExt(mismatched)))).toBeNull();
  });

  it("rejects a negative control revision", () => {
    expect(permissionControlFrom(envelope(reviewExt(control({ revision: -1 }))))).toBeNull();
  });
  it("does not fabricate rollback for an unobserved result", () => {
    const pc = control({ status: "unknown", reason: "observation_unavailable",
      submitted: { revision: 7, requested: { sandbox: "workspace-write", network_access: false }, execution_id: "exec-7" },
      rolled_back_to: { sandbox: "read-only", network_access: false } });
    expect(permissionControlFrom(envelope(reviewExt(pc)))).toBeNull();
  });
  it.each(["__proto__", "constructor", "toString"])("does not authorize a legacy mode picker from invalid mode %s", async (permission_mode) => {
    const { target } = await render({ engine: "claude-code", permission_mode });
    expect(rowByLabel(target, "作業意図")).toBeNull();
  });
});

describe("Fuji inherited error-map keys", () => {
  it.each(["constructor", "toString"])("renders unknown rejection %s as its raw value", async reason => {
    const { target } = await render(reviewExt(), {onSetPermission: vi.fn(async () => { throw new Error(reason); })});
    await reviewPick(target); await tick();
    expect(rowByLabel(target, "権限要求エラー")?.textContent?.trim()).toBe(reason);
  });
});

describe("permissionControlFrom per-status field table (ふじ round 1 M2)", () => {
  const ext = (pc: Record<string, unknown>) => ({
    engine: "codex",
    session_capabilities: SWITCH_CAPS,
    permission_control: pc,
  });
  const olderEvidence = {
    revision: 4,
    requested: { sandbox: "read-only", network_access: false },
    execution_id: "exec-4",
  };

  it("accepts a pending successor carrying its predecessor's evidence", () => {
    // "If revision B arrives while A runs, the top-level request is
    // B/pending while submitted and a known effective may describe A."
    // The applied binding must not be generalised into rejecting this.
    const parsed = permissionControlFrom(
      envelope(
        ext(
          control({
            revision: 9,
            submitted: olderEvidence,
            effective: {
              ...olderEvidence,
              session_id: "session-a",
              turn_id: "turn-4",
              permission: {
                sandbox: "read-only",
                approval: "never",
                enforcement: "os",
              },
              network_access: false,
            },
          }),
        ),
      ),
    );
    expect(parsed?.revision).toBe(9);
    expect(parsed?.status).toBe("pending");
  });

  it("accepts failed with its reason, evidence and rollback", () => {
    const parsed = permissionControlFrom(
      envelope(
        ext(
          control({
            status: "failed",
            reason: "policy_mismatch",
            submitted: { ...olderEvidence, revision: 7 },
            rolled_back_to: { sandbox: "read-only", network_access: false },
          }),
        ),
      ),
    );
    expect(parsed?.status).toBe("failed");
    expect(parsed?.rolled_back_to?.sandbox).toBe("read-only");
  });

  it("rejects applying without the submission that defines it", () => {
    expect(
      permissionControlFrom(envelope(ext(control({ status: "applying" })))),
    ).toBeNull();
  });

  it("rejects applying that publishes a current observation", () => {
    // The arm marks effective `never`: while an exec is capturing the
    // revision the current permission is unknown, and a prior observation
    // belongs in last_effective.
    const pc = observedControl(9);
    expect(
      permissionControlFrom(
        envelope(ext({ ...pc, status: "applying" })),
      ),
    ).toBeNull();
  });

  it("rejects unknown without a reason", () => {
    const pc = control({
      status: "unknown",
      submitted: { ...olderEvidence, revision: 7 },
    });
    expect(permissionControlFrom(envelope(ext(pc)))).toBeNull();
  });

  it("rejects a settled state that carries a reason its arm forbids", () => {
    const pc = { ...observedControl(9), reason: "policy_mismatch" };
    expect(permissionControlFrom(envelope(ext(pc)))).toBeNull();
  });

  it("reads an explicit null as absent rather than as a malformed value", () => {
    // JSON has no undefined, so a producer spelling "no rollback" as null
    // must not fail the forbidden-field check on a pending record.
    const pc = control({ reason: null, rolled_back_to: null });
    expect(permissionControlFrom(envelope(ext(pc)))?.status).toBe("pending");
  });
});
