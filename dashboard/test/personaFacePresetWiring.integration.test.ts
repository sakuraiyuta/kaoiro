// @vitest-environment jsdom
// issue #245 fix-round (ふじ round1 must-fix, confidence 0.99): the
// PersonaFace unit fixture (personaFace.test.ts) supplies all 6 props
// itself, so it cannot catch a production caller wiring the WRONG preset
// -- e.g. AgentCard.svelte passing size="timeline" instead of "card" is
// still a valid value of the union type, and personaFace.test.ts never
// looks at AgentCard.svelte at all. This integration test mounts the
// PRODUCTION components (AgentCard / AgentDetail / ResponseTimeline) and
// pins the actual props each one hands PersonaFace, via the resulting DOM
// (`data-size` attribute + alt/role/aria-label matrix). Expected values
// are the drift matrix recorded on issue #245
// (gitea.example.invalid/sakurai.yuta/kaoiro issue 245, comment 3475).
// App.svelte's agent-strip (size="chip") is covered separately in
// appAgentStripPresetWiring.integration.test.ts (needs the connectKaoiro
// mock harness, which would leak into this file's module scope).
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentCard from "../src/lib/AgentCard.svelte";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import ResponseTimeline from "../src/lib/ResponseTimeline.svelte";
import type { Envelope, PersonaManifest } from "../src/lib/protocol";

const mounted: object[] = [];

// AgentDetail's expand-from-origin transition (expandFrom) reads
// window.matchMedia; jsdom doesn't implement it. Mirrors
// agentDetailTaskRing.integration.test.ts's harness.
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

function personaEnvelope(agentId: string): Envelope {
  return {
    version: "0",
    agent_id: agentId,
    ts: "2026-08-20T00:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

const manifestWithSprite: PersonaManifest = {
  version: "1",
  personas: {
    p: {
      states: {
        idle: { url: "/sprites/p/idle.png", hash: "sha256:idle" },
      },
    },
  },
};

describe("AgentCard -> PersonaFace preset wiring", () => {
  it('sprite 無し face は size="card" / role="img" aria-label / aria-hidden 無し', async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(AgentCard, {
      target,
      props: { envelope: personaEnvelope("host-a.p"), manifest: null },
    });
    mounted.push(component);
    await tick();

    const face = target.querySelector(".face");
    expect(face?.getAttribute("data-size")).toBe("card");
    expect(face?.getAttribute("role")).toBe("img");
    expect(face?.getAttribute("aria-label")).toBe("idle");
    expect(face?.hasAttribute("aria-hidden")).toBe(false);
  });

  it('sprite 有り img は size="card" / alt=ラベル文字列', async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(AgentCard, {
      target,
      props: {
        envelope: personaEnvelope("host-a.p"),
        manifest: manifestWithSprite,
      },
    });
    mounted.push(component);
    await tick();

    const img = target.querySelector("img.portrait-sprite");
    expect(img?.getAttribute("data-size")).toBe("card");
    expect(img?.getAttribute("alt")).toBe("idle");
  });
});

describe("AgentDetail -> PersonaFace preset wiring", () => {
  it('sprite 無し face は size="detail" / role="img" aria-label / aria-hidden 無し', async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(AgentDetail, {
      target,
      props: {
        envelope: personaEnvelope("host-a.p"),
        manifest: null,
        onClose: vi.fn(),
      },
    });
    mounted.push(component);
    await tick();

    const face = target.querySelector(".face");
    expect(face?.getAttribute("data-size")).toBe("detail");
    expect(face?.getAttribute("role")).toBe("img");
    expect(face?.getAttribute("aria-label")).toBe("idle");
    expect(face?.hasAttribute("aria-hidden")).toBe(false);
  });

  it('sprite 有り img は size="detail" / alt=ラベル文字列', async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(AgentDetail, {
      target,
      props: {
        envelope: personaEnvelope("host-a.p"),
        manifest: manifestWithSprite,
        onClose: vi.fn(),
      },
    });
    mounted.push(component);
    await tick();

    const img = target.querySelector("img.portrait-sprite");
    expect(img?.getAttribute("data-size")).toBe("detail");
    expect(img?.getAttribute("alt")).toBe("idle");
  });
});

describe("ResponseTimeline -> PersonaFace preset wiring", () => {
  function renderRow(manifest: PersonaManifest | null) {
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(ResponseTimeline, {
      target,
      props: {
        agents: { "host-a.p": personaEnvelope("host-a.p") },
        logs: {
          "host-a.p": [
            {
              version: "0",
              agent_id: "host-a.p",
              ts: "2026-08-20T00:00:01Z",
              type: "log",
              state: "idle",
              payload: { kind: "assistant", text: "hi" },
            } as Envelope,
          ],
        },
        manifest,
        now: Date.parse("2026-08-20T00:00:10Z"),
        onSelectAgent: vi.fn(),
      },
    });
    mounted.push(component);
    return target;
  }

  it('sprite 無し face は size="timeline" / role="img" aria-label / aria-hidden 無し', async () => {
    const target = renderRow(null);
    await tick();

    const face = target.querySelector(".face");
    expect(face?.getAttribute("data-size")).toBe("timeline");
    expect(face?.getAttribute("role")).toBe("img");
    expect(face?.getAttribute("aria-label")).toBe("idle");
    expect(face?.hasAttribute("aria-hidden")).toBe(false);
  });

  it('sprite 有り img は size="timeline" / alt=""', async () => {
    const target = renderRow(manifestWithSprite);
    await tick();

    const img = target.querySelector("img.portrait-sprite");
    expect(img?.getAttribute("data-size")).toBe("timeline");
    expect(img?.getAttribute("alt")).toBe("");
  });
});
