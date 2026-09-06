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
    ["unknown", "未確認"],
  ])("renders status=%s as its own distinct state line", async (status, label) => {
    const { target } = await render({
      engine: "codex",
      session_capabilities: SWITCH_CAPS,
      permission_control: control({ status }),
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
      permission_control: control({ revision: 6, status: "applying" }),
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
      permission_control: control({ revision: 6, status: "applied" }),
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
