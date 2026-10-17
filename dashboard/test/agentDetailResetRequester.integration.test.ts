// @vitest-environment jsdom
// issue #677: while a reset is in flight AgentDetail says who started it when
// that was a director, so the operator does not read it as their own action.
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

function envelope(): Envelope {
  return {
    version: "0",
    agent_id: "host-a.p",
    ts: "2026-10-17T00:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    ext: {},
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

async function render(props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AgentDetail, {
    target,
    props: {
      envelope: envelope(),
      connection: {} as unknown as KaoiroConnection,
      onClose: vi.fn(),
      ...props,
    },
  });
  mounted.push(component);
  await tick();
  return target;
}

describe("AgentDetail reset progress attribution (issue #677)", () => {
  it("names the director and the work next to the mode", async () => {
    const target = await render({
      resetMode: "new",
      resetRequester: "director ひすい (work wrk_1) が要求",
    });
    expect(target.querySelector(".reset-progress")?.textContent).toContain(
      "director ひすい (work wrk_1) が要求",
    );
    expect(target.querySelector(".reset-progress")?.textContent).toContain("mode: new");
  });

  it("shows only the mode when nobody but the operator asked", async () => {
    const target = await render({ resetMode: "clear", resetRequester: null });
    const text = target.querySelector(".reset-progress")?.textContent ?? "";
    expect(text).toContain("mode: clear");
    expect(text).not.toContain("director");
  });

  it("shows nothing when no reset is in flight", async () => {
    const target = await render({ resetMode: null, resetRequester: "director x が要求" });
    expect(target.querySelector(".reset-progress")).toBeNull();
  });
});
