// @vitest-environment jsdom
// issue #287: an authentication (or other API-level) failure surfaces on
// the AgentDetail turn-end line. error_summary/recovery_hint are the
// wrapper's own bounded text (never raw SDK output); error_detail becomes
// an opt-in <details> expansion rather than an always-on line, per
// protocol.md's display-priority note (こはく裁定 2026-09-05).
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import type { Envelope } from "../src/lib/protocol";

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

function stateEnvelope(): Envelope {
  return {
    version: "0",
    agent_id: "host-a.p",
    ts: "2026-09-01T00:00:00Z",
    type: "state_change",
    state: "waiting_input",
    payload: {},
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

function resultLog(payload: Record<string, unknown>): Envelope {
  return {
    version: "0",
    agent_id: "host-a.p",
    ts: "2026-09-01T00:00:01Z",
    type: "result",
    state: "error",
    payload,
  };
}

async function render(logs: Envelope[]) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AgentDetail, {
    target,
    props: {
      envelope: stateEnvelope(),
      logs,
      agents: {},
      onClose: vi.fn(),
    },
  });
  mounted.push(component);
  await tick();
  return target;
}

describe("AgentDetail error surfacing (issue #287)", () => {
  it("error_summary は errLabel より優先して turn-end 行に出る", async () => {
    const target = await render([
      resultLog({
        is_error: true,
        error_subtype: "error_during_execution",
        error_code: "authentication_failed",
        error_summary: "認証の有効期限が切れました。",
        recovery_hint:
          "ホストで claude を対話起動し /login で再認証、その後このセッションを再起動してください。",
      }),
    ]);
    const turnEnd = target.querySelector(".turn-end");
    expect(turnEnd?.textContent).toContain("認証の有効期限が切れました。");
    // errLabel ("実行中エラー", error_during_execution の既存ラベル) は
    // error_summary があるとき出ない -- 併記して原因を薄めない。
    expect(turnEnd?.textContent).not.toContain("実行中エラー");
  });

  it("recovery_hint は専用行 (.turn-end-hint) に出る", async () => {
    const target = await render([
      resultLog({
        is_error: true,
        error_code: "authentication_failed",
        error_summary: "認証の有効期限が切れました。",
        recovery_hint: "ホストで /login してください。",
      }),
    ]);
    const hint = target.querySelector(".turn-end-hint");
    expect(hint?.textContent).toBe("ホストで /login してください。");
  });

  it("recovery_hint が無いときは .turn-end-hint を描画しない", async () => {
    const target = await render([
      resultLog({ is_error: true, error_subtype: "error_max_turns" }),
    ]);
    expect(target.querySelector(".turn-end-hint")).toBeNull();
  });

  it("error_detail は <details class=turn-end-detail> の展開式になる", async () => {
    const target = await render([
      resultLog({
        is_error: true,
        error_subtype: "error_during_execution",
        error_detail: "tool crashed: EACCES",
      }),
    ]);
    const details = target.querySelector("details.turn-end-detail");
    expect(details).not.toBeNull();
    expect(details?.querySelector("summary")).not.toBeNull();
    expect(details?.textContent).toContain("tool crashed: EACCES");
  });

  it("error_detail が無いときは turn-end-detail を描画しない", async () => {
    const target = await render([
      resultLog({
        is_error: true,
        error_code: "authentication_failed",
        error_summary: "認証の有効期限が切れました。",
      }),
    ]);
    expect(target.querySelector(".turn-end-detail")).toBeNull();
  });

  it("error_summary が無いときは従来どおり errLabel で表示する (回帰防止)", async () => {
    const target = await render([
      resultLog({ is_error: true, error_subtype: "error_max_turns" }),
    ]);
    expect(target.querySelector(".turn-end")?.textContent).toContain(
      "最大ターン数到達",
    );
  });
});
