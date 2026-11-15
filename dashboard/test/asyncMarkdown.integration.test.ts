// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import AsyncMarkdown from "../src/lib/AsyncMarkdown.svelte";
import UntrustedMarkdown from "../src/lib/UntrustedMarkdown.svelte";
import { markdownWorker } from "../src/lib/markdownWorker";
import { lexMarkdown, type LexResult } from "../src/lib/markdownTokens";
import { renderMarkdown, renderMarkdownTokens, renderMermaidIn } from "../src/lib/markdown";
import { renderUntrustedMarkdown, renderUntrustedTokens } from "../src/lib/untrustedMarkdown";
import { reactiveObject } from "./reactiveObject.svelte";

vi.mock("../src/lib/markdown", async (original) => ({
  ...await original<typeof import("../src/lib/markdown")>(),
  renderMermaidIn: vi.fn(async () => {}),
}));
let component: object;
afterEach(async () => {
  if (component) await unmount(component);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.mocked(renderMermaidIn).mockReset();
});
function mountBody(text: string, profile: "chat" | "full" = "chat") {
  const props = reactiveObject({ text, scope: "a", profile, onlayout: vi.fn() });
  component = mount(AsyncMarkdown, { target: document.body, props: {
    get text() { return props.text; }, get scope() { return props.scope; },
    get profile() { return props.profile; }, onlayout: props.onlayout,
  } });
  return props;
}

it.each(["chat", "full"] as const)("retains successful bytes and metadata: %s", async (profile) => {
  const source = "[ref][x]\n\n[x]: https://e.test\n\n日本語 **bold**\n\n" +
    "| A | B |\n|---|---|\n| 1 | 2 |\n\n```txt\n" + "x".repeat(100000) + "\n```";
  const expected = profile === "chat" ? renderMarkdown(source)
    : (renderUntrustedMarkdown(source) as { html: string }).html;
  const lexed = structuredClone(lexMarkdown(source));
  expect(lexed.kind).toBe("tokens");
  if (lexed.kind !== "tokens") throw Error("missing tokens");
  const actual = profile === "chat" ? renderMarkdownTokens(lexed.tokens)
    : (renderUntrustedTokens(lexed.tokens) as { html: string }).html;
  expect(actual).toBe(expected);
  mountBody(source, profile);
  await vi.waitFor(() => expect(document.querySelector("code")?.textContent?.length).toBe(100001));
  expect(document.querySelector("a")?.textContent).toBe("ref");
});

it("keeps source as text and rejects old callback after text/scope/profile change", async () => {
  const callbacks: ((r: LexResult) => void)[] = [];
  const cancels: ReturnType<typeof vi.fn>[] = [];
  vi.spyOn(markdownWorker, "request").mockImplementation((_owner, _source, receive) => {
    callbacks.push(receive); const cancel = vi.fn(); cancels.push(cancel); return cancel;
  });
  const props = mountBody('<img src=x onerror="alert(1)">\n  source');
  await tick();
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector(".markdown-source")?.textContent).toBe(props.text);
  props.text = "**new**"; props.scope = "b"; props.profile = "full";
  await tick();
  callbacks[0]!(lexMarkdown("old")); await tick();
  expect(document.querySelector(".markdown-source")?.textContent).toBe("**new**");
  expect(cancels[0]).toHaveBeenCalledOnce();
  callbacks[1]!(lexMarkdown("**new**")); await tick();
  expect(document.querySelector("strong")?.textContent).toBe("new");
  await unmount(component); component = undefined!;
  callbacks[1]!(lexMarkdown("resurrect")); await tick();
  expect(document.querySelector(".async-markdown")).toBeNull();
});

it("does not reuse old HTML while the changed source waits", async () => {
  const callbacks: ((r: LexResult) => void)[] = [];
  vi.spyOn(markdownWorker, "request").mockImplementation((_o, _s, cb) => {
    callbacks.push(cb); return () => {};
  });
  const props = mountBody("**old**"); await tick();
  callbacks[0]!(lexMarkdown("**old**")); await tick();
  props.text = "new"; await tick();
  expect(document.querySelector("strong")).toBeNull();
  expect(document.querySelector(".markdown-source")?.textContent).toBe("new");
});

it("invalidates a pending diagram and never reports stale layout", async () => {
  let finish!: () => void;
  vi.mocked(renderMermaidIn).mockImplementation(() => new Promise(r => { finish = r; }));
  const props = mountBody("```mermaid\ngraph TD;A-->B\n```");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const current = vi.mocked(renderMermaidIn).mock.calls[0]![1]!;
  expect(current()).toBe(true);
  props.text = "replacement";
  await tick();
  expect(current()).toBe(false);
  finish(); await tick();
  expect(props.onlayout).not.toHaveBeenCalled();
});

it("missing Worker keeps full source, never calls the synchronous renderer", async () => {
  vi.stubGlobal("Worker", undefined);
  mountBody("*a _b ".repeat(6000));
  await vi.waitFor(() => expect(document.querySelector('[data-markdown-state="plain"]')).not.toBeNull());
  expect(document.querySelector(".markdown-source")?.textContent).toHaveLength(36000);
  expect(document.querySelector(".markdown-note")?.textContent).toContain("再読み込み");
  expect(renderMermaidIn).not.toHaveBeenCalled();
});

it("leaves bounded full and inline previews synchronous without a Worker", async () => {
  vi.stubGlobal("Worker", undefined);
  const props = reactiveObject({ variant: "inline" as "inline" | "full", lines: 0 });
  component = mount(UntrustedMarkdown, { target: document.body, props: {
    text: "**one**\n\ntwo", get variant() { return props.variant; },
    get lines() { return props.lines; }, set lines(n) { props.lines = n; },
  } });
  await tick(); expect(props.lines).toBe(2);
  expect(document.querySelector("strong")?.textContent).toBe("one");
  props.variant = "full"; await tick(); expect(props.lines).toBe(0);
  expect(document.querySelector("p")?.textContent).toBe("one");
});
