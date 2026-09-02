// @vitest-environment jsdom
// AgentDetail のペルソナ画像クリック (issue #232): `.portrait-open` は
// `.portrait` の中の独立した <button> (AgentCard と違い、外側は <button>
// ではないのでネストできる) — クリックで onOpenPersonaDetail をペルソナ id
// で呼ぶ。personaId 不在または onOpenPersonaDetail 未指定なら disabled。
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

// No default value: a JS default parameter also applies when the caller
// passes `undefined` explicitly, which would silently defeat the
// "persona id 不在" test case below (envelope(undefined) would still get
// "p"). Every call site names its intent explicitly instead.
function envelope(personaId: string | undefined): Envelope {
  return {
    version: "0",
    agent_id: "host-a.p",
    ts: "2026-08-09T00:00:00Z",
    type: "state_change",
    state: "tool_running",
    payload: {},
    ...(personaId === undefined
      ? {}
      : { persona: { id: personaId, name: "P", sprite_set: "p" } }),
  };
}

async function render(props: {
  envelope: Envelope;
  onOpenPersonaDetail?: (personaId: string) => void;
}) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AgentDetail, {
    target,
    props: { manifest: null, onClose: vi.fn(), ...props },
  });
  mounted.push(component);
  await tick();
  return target;
}

describe("AgentDetail ペルソナ詳細モーダル (issue #232)", () => {
  it("`.portrait-open` のクリックは onOpenPersonaDetail をペルソナ id で呼ぶ", async () => {
    const onOpenPersonaDetail = vi.fn();
    const target = await render({ envelope: envelope("p"), onOpenPersonaDetail });

    const button = target.querySelector<HTMLButtonElement>(".portrait-open")!;
    expect(button.disabled).toBe(false);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(onOpenPersonaDetail).toHaveBeenCalledWith("p");
  });

  it("onOpenPersonaDetail 未指定なら `.portrait-open` が disabled になる", async () => {
    const target = await render({ envelope: envelope("p") });

    const button = target.querySelector<HTMLButtonElement>(".portrait-open")!;
    expect(button.disabled).toBe(true);
  });

  it("persona id 不在なら `.portrait-open` が disabled になる", async () => {
    const onOpenPersonaDetail = vi.fn();
    const target = await render({
      envelope: envelope(undefined),
      onOpenPersonaDetail,
    });

    const button = target.querySelector<HTMLButtonElement>(".portrait-open")!;
    expect(button.disabled).toBe(true);
  });
});
