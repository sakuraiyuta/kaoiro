// @vitest-environment jsdom
// The status line row on an agent card (issue 482, 514): the head as inline
// markdown with no pressable element inside, a sibling of the detail button,
// never aged or dimmed.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentCard from "../src/lib/AgentCard.svelte";
import type { Envelope } from "../src/lib/protocol";
import type { StatusLineView } from "../src/lib/statusLine";

const mounted: object[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-03T12:30:00Z"));
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function envelope(): Envelope {
  return {
    version: "0",
    agent_id: "host-a.p",
    ts: "2026-10-03T12:00:00Z",
    type: "state_change",
    state: "idle",
    payload: {},
    persona: { id: "p", name: "P", sprite_set: "p" },
  };
}

function setLine(overrides: Partial<Extract<StatusLineView, { kind: "set" }>> = {}): StatusLineView {
  return {
    kind: "set",
    head: "Reviewing issue 482",
    truncated: false,
    bytes: 19,
    updatedAt: "2026-10-03T12:00:00.000001Z",
    ...overrides,
  };
}

async function render(
  statusLine: StatusLineView | undefined,
  extra: Record<string, unknown> = {},
): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  const props: Record<string, unknown> = { envelope: envelope(), ...extra };
  if (statusLine !== undefined) props.statusLine = statusLine;
  mounted.push(mount(AgentCard, { target, props: props as never }));
  await tick();
  return target;
}

const row = (target: HTMLElement) => target.querySelector<HTMLButtonElement>("button.status-line");

describe("AgentCard status line row", () => {
  it("draws no row when the card is told nothing, or told none", async () => {
    expect(row(await render(undefined))).toBeNull();
    expect(row(await render({ kind: "none" }))).toBeNull();
  });

  it("says 未設定 for an agent that is known to have no line", async () => {
    const button = row(await render({ kind: "unset" }));

    expect(button?.textContent?.trim()).toBe("未設定");
    expect(button?.classList.contains("unset")).toBe(true);
  });

  it("shows the head as markdown, the clock time, and how long ago in the title", async () => {
    const head = "Reviewing **issue** 482";
    const button = row(await render(setLine({ head, bytes: head.length })))!;

    expect(button.querySelector(".status-text")?.textContent).toBe("Reviewing issue 482");
    expect(button.querySelector(".status-text strong")?.textContent).toBe("issue");
    expect(button.querySelector(".status-time")?.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(button.querySelector(".status-time")?.getAttribute("title")).toBe("30 分前");
    expect(button.querySelector(".status-more")).toBeNull();
  });

  it("does not age or dim the row, however old the line is", async () => {
    const button = row(await render(setLine({ updatedAt: "2025-01-01T00:00:00.000000Z" })))!;

    // Svelte adds its scoped hash class; nothing of ours beyond the base class.
    expect([...button.classList].filter((c) => !c.startsWith("svelte-"))).toEqual(["status-line"]);
    expect(button.getAttribute("style")).toBeNull();
    expect(button.querySelector(".status-text")?.getAttribute("style")).toBeNull();
  });

  it("says there is more when the server cut the head", async () => {
    const button = row(await render(setLine({ truncated: true, bytes: 2048 })))!;

    expect(button.querySelector(".status-more")?.textContent).toBe("…続きあり (2.0 KB)");
  });

  it("says there is more when the head draws more than three lines", async () => {
    const four = row(await render(setLine({ head: "a\nb\nc\nd", bytes: 7 })))!;
    const three = row(await render(setLine({ head: "a\nb\nc", bytes: 5 })))!;

    expect(four.querySelector(".status-more")).not.toBeNull();
    expect(three.querySelector(".status-more")).toBeNull();
  });

  it("counts the lines it draws, not the lines of the source", async () => {
    // Five source lines, three drawn: everything is visible.
    const spaced = row(await render(setLine({ head: "a\n\nb\n\nc", bytes: 7 })))!;
    // Four paragraphs are four drawn lines.
    const four = row(await render(setLine({ head: "a\n\nb\n\nc\n\nd", bytes: 11 })))!;

    expect(spaced.querySelector(".status-more")).toBeNull();
    expect(four.querySelector(".status-more")).not.toBeNull();
  });

  it("shows hostile markup literally and makes no image or anchor from it, but draws the markdown", async () => {
    const head = "<img src=x onerror=alert(1)> [click](https://evil.example/) **bold**";
    const button = row(await render(setLine({ head, bytes: head.length })))!;

    expect(button.querySelector("img")).toBeNull();
    expect(button.querySelector("a")).toBeNull();
    expect(button.querySelector("strong")?.textContent).toBe("bold");
    expect(button.querySelector("span.md-link")?.textContent).toBe("click");
    expect(button.querySelector(".status-text")?.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("holds no pressable or block element, whatever markdown the head is", async () => {
    const head = "# T\n\n- [x] a\n- [ ] b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> q\n\n```\ncode\n```\n\n[x](https://e.test/) ![i](https://e.test/p.png) <div>d</div> <a href=\"https://e.test/\">raw</a>";
    const button = row(await render(setLine({ head, bytes: head.length })))!;

    expect(
      button.querySelector("a, button, input, select, textarea, [tabindex], div, p, h1, h2, ul, ol, li, table, img, pre, blockquote"),
    ).toBeNull();
    expect(button.querySelectorAll("[class]").length).toBeGreaterThan(0);
  });

  it("opens the change log when a link's label is pressed, and goes nowhere", async () => {
    const onOpenStatusLineHistory = vi.fn();
    const head = "see [#482](https://github.com/o/r/issues/482)";
    const target = await render(setLine({ head, bytes: head.length }), { onOpenStatusLineHistory });

    target.querySelector<HTMLElement>("span.md-link")!.click();

    expect(target.querySelector("a")).toBeNull();
    expect(onOpenStatusLineHistory).toHaveBeenCalledWith("host-a.p");
  });

  it("is a sibling of the detail button, not nested in it", async () => {
    const target = await render(setLine());
    const button = row(target)!;

    expect(button.closest("button.open")).toBeNull();
    expect(button.parentElement).toBe(target.querySelector("article"));
    expect(button.parentElement).toBe(target.querySelector("button.open")!.parentElement);
  });

  it("opens the change log for the agent and not the detail view, with no stopPropagation", async () => {
    const onOpenStatusLineHistory = vi.fn();
    const onSelect = vi.fn();
    const target = await render(setLine(), { onOpenStatusLineHistory, onSelect });
    const reachedArticle = vi.fn();
    target.querySelector("article")!.addEventListener("click", reachedArticle);
    // Svelte delegates onclick to the root, so a handler that stopped
    // propagation would not stop a listener on the card itself; asserting that
    // nobody asks for it is what pins the structural separation.
    const stopped = vi.spyOn(Event.prototype, "stopPropagation");

    row(target)!.click();

    expect(onOpenStatusLineHistory).toHaveBeenCalledWith("host-a.p");
    expect(onSelect).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();
    // The click bubbled to the card untouched: the separation is the markup's.
    expect(reachedArticle).toHaveBeenCalledTimes(1);
    stopped.mockRestore();
  });

  it("is offered on a directory-only card too, and works without the operator's connection", async () => {
    const onOpenStatusLineHistory = vi.fn();
    const target = await render(setLine(), { directoryOnly: true, onOpenStatusLineHistory });

    row(target)!.click();

    expect(onOpenStatusLineHistory).toHaveBeenCalledWith("host-a.p");
  });

  it("is disabled when nothing can open the log", async () => {
    expect(row(await render(setLine()))?.disabled).toBe(true);
  });
});
