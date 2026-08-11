// @vitest-environment jsdom
// AgentDetail の todo float (issue #188 / ADR-0049): current tasklist state
// is deliberately separate from the append-only transcript and from the
// child-task activity ring. These tests mount the production detail rather
// than only exercising the aggregate helper, pinning the operator-visible
// collapsed/expanded contract.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import { applyTaskEnvelope, tasklistForAgent } from "../src/lib/protocol";
import type { Envelope, TasklistSnapshot } from "../src/lib/protocol";

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

function envelope(): Envelope {
  return {
    version: "0",
    agent_id: "host-a.p",
    ts: "2026-08-10T00:00:00Z",
    type: "state_change",
    state: "tool_running",
    payload: {},
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

async function render(tasklist: TasklistSnapshot | null): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AgentDetail, {
    target,
    props: { envelope: envelope(), tasklist, onClose: vi.fn() },
  });
  mounted.push(component);
  await tick();
  return target;
}

describe("AgentDetail tasklist float (issue #188)", () => {
  it("tasklist が無い、または空なら 0/0 float を表示しない", async () => {
    const absent = await render(null);
    expect(absent.querySelector(".tasklist-float")).toBeNull();

    const empty = await render({ items: [] });
    expect(empty.querySelector(".tasklist-float")).toBeNull();
  });

  it("omitted を completed/total へ足し、クリックで詳細と折りたたみを切り替える", async () => {
    const parent = envelope();
    const taskEnvelope = {
      ...parent,
      type: "task",
      payload: {
        agent_id: parent.agent_id,
        task_id: "tasklist",
        task_type: "tasklist",
        kind: "updated",
        status: "running",
        items: [
          { text: "調査", status: "completed" },
          { text: "実装", status: "in_progress" },
        ],
        omitted: { count: 2, completed: 1 },
      },
    } as Envelope;
    const tasklist = tasklistForAgent(
      applyTaskEnvelope({}, taskEnvelope),
      parent.agent_id,
    );
    const target = await render(tasklist);
    const toggle = target.querySelector(".tasklist-toggle") as HTMLButtonElement;

    // Visible items: 1 completed / 2 total. Omitted: 1 completed / 2 total.
    // The compact float must expose the combined, truthful [2]/[4] reading.
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent?.replace(/\s+/g, " ").trim()).toContain("TODO [2/4] 詳細");
    expect(target.querySelector(".tasklist-items")).toBeNull();

    toggle.click();
    await tick();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(target.querySelectorAll(".tasklist-item")).toHaveLength(2);
    expect(target.querySelector('.tasklist-item[data-status="completed"]')?.textContent).toContain(
      "完了: 調査",
    );
    expect(target.querySelector(".tasklist-omitted")?.textContent).toContain(
      "以下 2 件省略 (うち完了 1 件)",
    );

    toggle.click();
    await tick();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(target.querySelector(".tasklist-items")).toBeNull();
  });
});
