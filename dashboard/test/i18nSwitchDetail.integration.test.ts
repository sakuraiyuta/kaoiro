import "./isolation.setup";
// @vitest-environment jsdom
// Issue #269 U3: the agent detail screen, its todo float and the protocol
// helpers repaint on a language switch without a reload. The tests start in ja
// (locale.setup.ts) and name the elements they read by class or role and the
// table key. Strings that used to be module- or script-level constants are
// read through the screen or the helper that now looks them up.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import TasklistFloat from "../src/lib/TasklistFloat.svelte";
import {
  describeResetRequester,
  disconnectLabel,
  errorSubtypeLabel,
} from "../src/lib/protocol";
import type { Envelope, KaoiroConnection } from "../src/lib/protocol";
import { en } from "../src/lib/i18n/en";
import { ja } from "../src/lib/i18n/ja";
import { setLocale } from "../src/lib/i18n/index.svelte";

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

function envelope(ext: Record<string, unknown>): Envelope {
  return {
    version: "0",
    agent_id: "host-a.p",
    ts: "2026-09-06T00:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    ext,
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

const SWITCH_CAPS = {
  supports_attachments: false,
  supports_user_input_dialog: true,
  supports_permission_switch: true,
};

async function renderDetail(
  ext: Record<string, unknown>,
  props: Record<string, unknown> = {},
) {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(
    mount(AgentDetail, {
      target,
      props: {
        envelope: envelope(ext),
        connection: {} as unknown as KaoiroConnection,
        onClose: vi.fn(),
        ...props,
      },
    }),
  );
  await tick();
  return target;
}

function text(element: Element | null | undefined): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function row(target: HTMLElement, label: string): HTMLElement | null {
  for (const candidate of target.querySelectorAll<HTMLElement>(".cc-row")) {
    if (text(candidate.querySelector("dt")) === label) {
      return candidate.querySelector("dd");
    }
  }
  return null;
}

describe("protocol helpers", () => {
  it("errorSubtypeLabel, disconnectLabel and describeResetRequester follow the locale at call time", () => {
    const reset = () =>
      describeResetRequester(
        { origin: "director", requested_by: { kind: "agent", id: "a" }, work_id: "wrk_1" },
        () => "Hisui",
      );
    expect(errorSubtypeLabel("error_max_turns")).toBe(ja.protocol.errorSubtype.error_max_turns);
    expect(disconnectLabel({ origin: "operator", reason: "stop" })).toBe(ja.protocol.disconnectOperator);
    expect(reset()).toBe("director Hisui (work wrk_1) が要求");

    setLocale("en");
    expect(errorSubtypeLabel("error_max_turns")).toBe("Maximum turns reached");
    expect(errorSubtypeLabel("some_new_subtype")).toBeNull();
    expect(disconnectLabel({ origin: "operator", reason: "stop" })).toBe("Stopped by the operator");
    expect(disconnectLabel({ origin: "unplanned", reason: "socket_lost" })).toBe(
      en.protocol.disconnectUnplanned,
    );
    expect(reset()).toBe("requested by director Hisui (work wrk_1)");

    setLocale("ja");
    expect(errorSubtypeLabel("error_max_turns")).toBe("最大ターン数到達");
  });
});

describe("AgentDetail repaints on setLocale", () => {
  it("bar, composer and the destructive buttons", async () => {
    const target = await renderDetail({});
    const back = () => target.querySelector<HTMLButtonElement>("button.back")!;
    const textarea = () => target.querySelector<HTMLTextAreaElement>("form.instruct textarea")!;
    const send = () => target.querySelector<HTMLButtonElement>('form.instruct button[type="submit"]')!;
    const composer = () => target.querySelector<HTMLElement>(".composer")!;
    const terminate = () => target.querySelector<HTMLButtonElement>("button.terminate")!;
    const clear = () => target.querySelector<HTMLButtonElement>("button.clear-history")!;

    expect(text(back())).toBe(ja.agentDetail.backToGrid);
    expect(textarea().placeholder).toBe(ja.agentDetail.composerPlaceholder);
    expect(text(send())).toBe(ja.agentDetail.send);
    expect(composer().getAttribute("aria-label")).toBe(ja.agentDetail.composerAria);
    expect(text(terminate())).toBe(ja.agentDetail.terminate);
    expect(terminate().title).toBe(ja.agentDetail.terminateTitle);
    expect(text(clear())).toBe(ja.agentDetail.clearHistory);
    expect(clear().title).toBe(ja.agentDetail.clearHistoryDisabledTitle);

    setLocale("en");
    await tick();
    expect(text(back())).toBe("Back to the grid");
    expect(textarea().placeholder).toBe(en.agentDetail.composerPlaceholder);
    expect(text(send())).toBe("Send");
    expect(composer().getAttribute("aria-label")).toBe(en.agentDetail.composerAria);
    expect(text(terminate())).toBe("Terminate agent");
    expect(terminate().title).toBe(en.agentDetail.terminateTitle);
    expect(text(clear())).toBe(en.agentDetail.clearHistory);
    expect(clear().title).toBe(en.agentDetail.clearHistoryDisabledTitle);
  });

  it("the terminate confirmation is worded by the locale", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    window.confirm = confirm;
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
      mount(AgentDetail, {
        target,
        props: {
          envelope: { ...envelope({}), state: "thinking" },
          connection: { stop: vi.fn() } as unknown as KaoiroConnection,
          onClose: vi.fn(),
        },
      }),
    );
    await tick();
    target.querySelector<HTMLButtonElement>("button.terminate")!.click();
    expect(confirm).toHaveBeenLastCalledWith(
      "「host-a.p」はthinkingです。終了すると進行中の作業は失われる可能性があります。終了しますか?",
    );
    setLocale("en");
    await tick();
    target.querySelector<HTMLButtonElement>("button.terminate")!.click();
    expect(confirm).toHaveBeenLastCalledWith(
      '"host-a.p" is thinking. Terminating it may lose work in progress. Terminate?',
    );
    vi.unstubAllGlobals();
  });

  it("status rows whose text was a script-level constant", async () => {
    const target = await renderDetail(
      {
        engine: "codex",
        session_capabilities: SWITCH_CAPS,
        rate_limits: { overage: { utilization: 0.4 } },
        permission_control: {
          revision: 7,
          requested: { sandbox: "workspace-write", network_access: false },
          constraints: { approval: "never", enforcement: "os" },
          status: "failed",
          reason: "approval_policy_mismatch",
          rolled_back_to: { sandbox: "read-only", network_access: false },
        },
      },
      { onSetPermission: vi.fn(async () => null) },
    );

    // ja: the composed lines read exactly as before the move.
    const request = () => row(target, ja.agentDetail.permissionRequest) ?? row(target, en.agentDetail.permissionRequest);
    expect(text(request())).toContain(`rev 7 — ${ja.agentDetail.permissionStatus.failed}`);
    expect(text(request())).toContain("要求: 書込 workspace-write / network false");
    expect(text(request())).toContain("適用前に戻した設定: 書込 read-only / network false");
    expect(text(request())).toContain(ja.agentDetail.codexApprovalConfigRecovery);
    expect(row(target, ja.agentDetail.rateOverage)).not.toBeNull();
    expect(text(row(target, ja.agentDetail.effectiveWriteScope))).toBe(
      "書込: 未確認 / 承認: never(host-fixed)",
    );

    setLocale("en");
    await tick();
    expect(text(request())).toContain("rev 7 — Failed");
    expect(text(request())).toContain("Requested: write workspace-write / network false");
    expect(text(request())).toContain(
      "Settings restored before applying: write read-only / network false",
    );
    expect(text(request())).toContain(en.agentDetail.codexApprovalConfigRecovery);
    expect(row(target, ja.agentDetail.rateOverage)).toBeNull();
    expect(row(target, "extra")).not.toBeNull();
    expect(text(row(target, en.agentDetail.effectiveWriteScope))).toBe(
      "write: unconfirmed / approval: never(host-fixed)",
    );
  });

  it("a rejected permission request is worded in the locale of the moment it failed", async () => {
    const onSetPermission = vi.fn(async () => {
      throw new Error("forbidden");
    });
    const target = await renderDetail(
      {
        engine: "codex",
        session_capabilities: SWITCH_CAPS,
        permission_control: {
          revision: 7,
          requested: { sandbox: "workspace-write", network_access: false },
          constraints: { approval: "never", enforcement: "os" },
          status: "pending",
        },
      },
      { onSetPermission },
    );
    const pick = async (label: string) => {
      const dd = row(target, label)!;
      dd.querySelector<HTMLButtonElement>(".cc-perm-switch")!.click();
      await tick();
      dd.querySelector<HTMLButtonElement>('[role="option"]')!.click();
      await vi.waitFor(() => expect(onSetPermission).toHaveBeenCalled());
      await tick();
    };

    await pick(ja.agentDetail.sandboxChange);
    expect(text(row(target, ja.agentDetail.permissionRequestError))).toBe(
      "権限がありません (operator のみ実行できます)",
    );

    setLocale("en");
    await tick();
    onSetPermission.mockClear();
    await pick(en.agentDetail.sandboxChange);
    expect(text(row(target, en.agentDetail.permissionRequestError))).toBe(
      en.agentDetail.permissionError.forbidden,
    );
  });
});

describe("TasklistFloat repaints on setLocale", () => {
  it("aria-labels, the toggle, item status and the omitted line", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
      mount(TasklistFloat, {
        target,
        props: {
          agentId: "host-a.p",
          tasklist: {
            items: [{ text: "first", status: "in_progress" }],
            omitted: { count: 3, completed: 1 },
          },
        },
      }),
    );
    await tick();
    const float = () => target.querySelector<HTMLElement>(".tasklist-float")!;
    const action = () => target.querySelector<HTMLElement>(".tasklist-action")!;

    expect(float().getAttribute("aria-label")).toBe(ja.tasklistFloat.listAria);
    expect(text(action())).toBe(ja.tasklistFloat.expand);
    target.querySelector<HTMLButtonElement>(".tasklist-toggle")!.click();
    await tick();
    expect(text(action())).toBe(ja.tasklistFloat.collapse);
    expect(text(target.querySelector(".sr-only"))).toBe("進行中:");
    expect(text(target.querySelector(".tasklist-omitted"))).toBe("以下 3 件省略 (うち完了 1 件)");
    expect(target.querySelector(".tasklist-items")?.getAttribute("aria-label")).toBe(
      ja.tasklistFloat.detailAria,
    );

    setLocale("en");
    await tick();
    expect(float().getAttribute("aria-label")).toBe("Current todo list");
    expect(text(action())).toBe("Collapse");
    expect(text(target.querySelector(".sr-only"))).toBe("In progress:");
    expect(text(target.querySelector(".tasklist-omitted"))).toBe(
      en.tasklistFloat.omitted({ count: 3, completed: 1 }),
    );
    expect(target.querySelector(".tasklist-items")?.getAttribute("aria-label")).toBe(
      "Todo details",
    );
  });
});
