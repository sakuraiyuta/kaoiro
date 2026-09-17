// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentCard from "../src/lib/AgentCard.svelte";
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

function disconnected(ext: Record<string, unknown> = {}): Envelope {
  return {
    version: "0",
    agent_id: "host.agent",
    persona: { id: "momo", name: "もも", sprite_set: "momo" },
    ts: "2026-09-18T00:00:00Z",
    type: "state_change",
    state: "disconnected",
    payload: {},
    ext,
  };
}

async function renderBoth(envelope: Envelope): Promise<HTMLElement[]> {
  const cardTarget = document.createElement("div");
  const detailTarget = document.createElement("div");
  document.body.append(cardTarget, detailTarget);
  mounted.push(mount(AgentCard, { target: cardTarget, props: { envelope } }));
  mounted.push(
    mount(AgentDetail, {
      target: detailTarget,
      props: { envelope, agents: { [envelope.agent_id]: envelope }, onClose: vi.fn() },
    }),
  );
  await tick();
  return [cardTarget, detailTarget];
}

describe("disconnect origin display", () => {
  it("shows the same Japanese reason on the card and detail", async () => {
    const targets = await renderBoth(
      disconnected({ disconnect: { origin: "agent_self", reason: "crash" } }),
    );
    for (const target of targets) {
      expect(target.querySelector(".disconnect-reason")?.textContent).toBe(
        "エージェントの異常終了",
      );
      expect(target.textContent).not.toContain("agent_self");
      expect(target.textContent).not.toContain("crash");
    }
  });

  it("keeps the legacy fallback when attribution is absent or invalid", async () => {
    for (const envelope of [
      disconnected(),
      disconnected({ disconnect: { origin: "operator", reason: "crash" } }),
    ]) {
      const targets = await renderBoth(envelope);
      for (const target of targets) {
        expect(target.querySelector(".disconnect-reason")).toBeNull();
        expect(target.textContent).toContain("offline");
      }
      for (const component of mounted.splice(0)) await unmount(component);
      document.body.innerHTML = "";
    }
  });
});
