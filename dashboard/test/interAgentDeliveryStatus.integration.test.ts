// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import type { Envelope } from "../src/lib/protocol";

let component: object | null = null;
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({
    matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) });
});
afterEach(async () => {
  if (component !== null) await unmount(component);
  component = null;
  document.body.innerHTML = "";
});

it("shows uncertainty separately from loss and the resolved watermark", async () => {
  const envelope: Envelope = { version: "0", agent_id: "host-a.p", ts: "2026-10-01T00:00:00Z",
    type: "state_change", state: "waiting_input", payload: {}, ext: { model: "gpt-6-sol" },
    persona: { id: "p", name: "P", sprite_set: "p" } };
  const target = document.createElement("div");
  document.body.append(target);
  component = mount(AgentDetail, { target, props: { envelope, logs: [], agents: {}, onClose: vi.fn(),
    deliveryStatus: { issued_seq: 3, acked_seq: 3, lost_count: 0, uncertain_count: 2,
      last_uncertain: { at: "2026-10-01T00:00:00Z", incarnation: "inc", generation: "gen",
        delivery_seq: 3, reason: "turn_steer_timeout" } } } });
  await tick();
  const row = target.querySelector('[data-testid="inter-agent-delivery-status"]');
  expect(row?.textContent).toContain("3/3");
  expect(row?.textContent).toContain("喪失 0");
  expect(row?.textContent).toContain("未確定 2");
  expect(row?.querySelector('[title="seq 3: turn_steer_timeout"]')).not.toBeNull();
});
