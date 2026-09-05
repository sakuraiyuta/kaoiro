// @vitest-environment jsdom
// issue #287: the needs-attention badge (.badge) must stay lit after an
// error result's live `error` state moves on to `waiting_input` (protocol.md:
// error/done are momentary), until the operator acks by opening the detail.
// App.svelte owns the ack bookkeeping; this pins AgentCard's own half —
// hasUnackedError extends `attention` independently of the live state.
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentCard from "../src/lib/AgentCard.svelte";
import type { Envelope } from "../src/lib/protocol";

const mounted: object[] = [];

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function envelope(state: string): Envelope {
  return {
    version: "0",
    agent_id: "host-a.p",
    ts: "2026-09-01T00:00:00Z",
    type: "state_change",
    state,
    payload: {},
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

async function render(state: string, hasUnackedError: boolean) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AgentCard, {
    target,
    props: { envelope: envelope(state), hasUnackedError },
  });
  mounted.push(component);
  await tick();
  return target;
}

describe("AgentCard needs-attention badge — hasUnackedError (issue #287)", () => {
  it("waiting_input + hasUnackedError=true でもバッジを表示する", async () => {
    const target = await render("waiting_input", true);
    expect(target.querySelector(".badge")).not.toBeNull();
  });

  it("waiting_input + hasUnackedError=false ではバッジを表示しない", async () => {
    const target = await render("waiting_input", false);
    expect(target.querySelector(".badge")).toBeNull();
  });

  it("error state は hasUnackedError 省略時 (既定 false) でもバッジを表示する (回帰防止)", async () => {
    const target = await render("error", false);
    expect(target.querySelector(".badge")).not.toBeNull();
  });
});
