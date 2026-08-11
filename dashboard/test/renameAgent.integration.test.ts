// @vitest-environment jsdom
// Component-level coverage for the rename UI (issue #197 段階3 unit B).
// Pins the 4 points ふじ specified as sufficient for the UI side of the
// acceptance seam: operator/viewer DOM presence, single-call submit,
// error surfacing through the shared actionError path, and envelope-
// driven display-name tracking (no stale local draft/cache). Mirrors
// modelSwitch.integration.test.ts's harness (mount(AgentDetail), DOM-
// driven interaction, stubbed callbacks — no real socket; the wire shape
// itself is covered separately by renameAgentWire.integration.test.ts).
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import { makeReactiveAgentDetailProps } from "./reactiveProps.svelte";
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

function envelopeFor(name: string, ext?: Record<string, unknown>): Envelope {
  return {
    version: "0",
    agent_id: "host-a.ao",
    ts: "2026-08-11T00:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    persona: { id: "ao", name, sprite_set: "ao" },
    // issue #219 D19: display_name is what the UI actually shows — this
    // helper's `name` param seeds both, matching every EXISTING caller's
    // intent ("the shown name"); a test that needs canonical/display_name
    // to DIVERGE builds its own fixture (D27 acceptance pin) rather than
    // through this shared helper.
    display_name: name,
    ...(ext === undefined ? {} : { ext }),
  };
}

function renameButton(target: Element): HTMLButtonElement | null {
  return target.querySelector(".rename-switch");
}

/** A minimal connection stub — only present so the `{#if connection}`-
 *  gated composer area (which the shared actionError display, `.action-
 *  error`, lives inside) renders at all. Its methods are never called by
 *  these tests: rename goes through the separate `onRename` prop, not
 *  through this connection. */
function stubConnection(): KaoiroConnection {
  return {} as unknown as KaoiroConnection;
}

async function renderDetail(
  envelope: Envelope,
  onRename?: (agentId: string, name: string) => Promise<void>,
) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AgentDetail, {
    target,
    props: {
      envelope,
      connection: stubConnection(),
      onClose: vi.fn(),
      ...(onRename === undefined ? {} : { onRename }),
    },
  });
  mounted.push(component);
  await tick();
  return target;
}

describe("AgentDetail rename UI (issue #197 段階3 unit B, ふじ判定 4 点)", () => {
  it("(1) operator (onRename あり) には rename control が見え、viewer (onRename 無し) には DOM 自体が無い", async () => {
    const operatorTarget = await renderDetail(
      envelopeFor("あお"),
      vi.fn(async () => undefined),
    );
    expect(renameButton(operatorTarget)).not.toBeNull();

    const viewerTarget = await renderDetail(envelopeFor("あお"));
    expect(renameButton(viewerTarget)).toBeNull();
  });

  // issue #197 段階3 ふじ MF-2 レビュー指摘: 以前は `onRename` が
  // `(name) => Promise<void>` のみで、agent_id は呼び出し元
  // (App.svelte) の closure に依存していた — その closure を
  // "wrong.id" のような別 agent へ変異させても、この component test も
  // wire test も検出できない seam だった。`onRename` を
  // `(agentId, name) => Promise<void>` に変え、AgentDetail 自身が
  // `envelope.agent_id` を読んで渡す構造にしたことで、この agent_id が
  // COMPONENT の外から来ない (closure で後付けされない) ことを直接
  // pin できる。
  it("(2) submit は現在の agent_id と入力名で 1 回だけ renameAgent (onRename) を呼ぶ", async () => {
    const onRename = vi.fn(async () => undefined);
    const target = await renderDetail(envelopeFor("あお"), onRename);

    renameButton(target)!.click();
    await tick();
    const input = target.querySelector(".rename-form input") as HTMLInputElement;
    input.value = "あお(改名)";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    target
      .querySelector(".rename-form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await tick();

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("host-a.ao", "あお(改名)");
  });

  it("(3) reject reason は既存 actionError 経路にそのまま表示される (reason 別の分岐は無い)", async () => {
    const onRename = vi.fn(async () => {
      throw new Error("invalid_name");
    });
    const target = await renderDetail(envelopeFor("あお"), onRename);

    renameButton(target)!.click();
    await tick();
    const input = target.querySelector(".rename-form input") as HTMLInputElement;
    input.value = "だめな名前";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    target
      .querySelector(".rename-form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    // The catch runs on the microtask after the awaited rejection settles.
    await Promise.resolve();
    await Promise.resolve();
    await tick();
    await tick();

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(target.querySelector(".action-error")?.textContent).toBe("invalid_name");
    // Failure leaves the popover open — the operator sees the error next
    // to the input and can retry without reopening (no bespoke retry
    // button, director's decision).
    expect(target.querySelector(".rename-form")).not.toBeNull();
  });

  // issue #197 段階3 ふじ MF-4 レビュー指摘: 以前は blank (trim 後空文字)
  // を `trimmed === "" || trimmed === name` の early-return で、server
  // へ送らず error surface も出さずに閉じていた — これは D5 (server-
  // authority-only validation) の合意に反する undocumented な
  // client-side validation だった。blank も unchanged 同様「送信し
  // ない」のではなく、1 回送信されて server の invalid_name reject が
  // 通常の actionError 経路に出ることを直接 pin する。前の "だめな
  // 名前" テストは実 server なら valid な文字列で reject する mock
  // だったため、この gap を検出できていなかった。
  it("(6) blank (空白のみ) は握り潰さず 1 回送信され、reject が actionError に表示される", async () => {
    const onRename = vi.fn(async () => {
      throw new Error("invalid_name");
    });
    const target = await renderDetail(envelopeFor("あお"), onRename);

    renameButton(target)!.click();
    await tick();
    const input = target.querySelector(".rename-form input") as HTMLInputElement;
    input.value = "   ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    target
      .querySelector(".rename-form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    await tick();
    await tick();

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("host-a.ao", "");
    expect(target.querySelector(".action-error")?.textContent).toBe("invalid_name");
  });

  it("(4) 親から新しい envelope が渡ると表示名が追随し、popover 再 open 時の draft も古い名前を残さない", async () => {
    const onRename = vi.fn(async () => undefined);
    const target = document.createElement("div");
    document.body.append(target);
    const props = makeReactiveAgentDetailProps({
      envelope: envelopeFor("あお"),
      connection: null as unknown as KaoiroConnection,
      onClose: vi.fn(),
      onRename,
    });
    const component = mount(AgentDetail, { target, props });
    mounted.push(component);
    await tick();

    expect(target.querySelector("h2")?.textContent).toBe("あお");

    // Server-applied rename lands as the agent's NEXT envelope (a live
    // wrapper re-emits state_change immediately after persona_sync) —
    // simulate that arriving independently of this component's own
    // (unrelated) draft state, which never got touched here.
    props.envelope = envelopeFor("あお(改名)");
    await tick();
    expect(target.querySelector("h2")?.textContent).toBe("あお(改名)");

    // Reopening the popover must seed the draft from the NEW name, not a
    // stale local cache of the old one — the failure mode this point
    // guards against (issue #197 段階3 ふじ 判定, UI 側 (4)).
    renameButton(target)!.click();
    await tick();
    const input = target.querySelector(".rename-form input") as HTMLInputElement;
    expect(input.value).toBe("あお(改名)");
  });

  // 内部レビュー Workflow 指摘 (issue #197 段階3 unit B, medium severity):
  // toggleModelMenu/toggleEffortMenu/togglePermMenu は互いの popover を
  // 閉じるが、新設した rename popover (renameMenuOpen) だけリセットし
  // 忘れていた (非対称)。逆方向 (toggleRenameMenu が他 3 つを閉じる) は
  // 元から正しかったため片側だけ気づきにくいバグだった。放置すると
  // rename popover を開いたまま model/effort/permission の切替 button を
  // クリックした際、両方の popover が同時に開いたまま残る。
  it("(5) rename popover を開いた状態で model 切替 button を押すと rename popover が閉じる (内部レビュー指摘の回帰)", async () => {
    const onRename = vi.fn(async () => undefined);
    const target = await renderDetail(
      envelopeFor("あお", {
        engine: "codex",
        model: "gpt-terra",
        models: [
          { value: "gpt-terra", display_name: "Terra", effort_levels: ["low"] },
        ],
        session_capabilities: {
          supports_attachments: false,
          supports_user_input_dialog: true,
          supports_model_switch: true,
        },
      }),
      onRename,
    );

    renameButton(target)!.click();
    await tick();
    expect(target.querySelector(".rename-form")).not.toBeNull();

    const modelBtn = target.querySelector(
      '[title="モデルを切替"]',
    ) as HTMLButtonElement;
    expect(modelBtn).not.toBeNull();
    modelBtn.click();
    await tick();

    expect(target.querySelector(".rename-form")).toBeNull();
    expect(target.querySelector('[aria-label="モデル候補"]')).not.toBeNull();
  });
});
