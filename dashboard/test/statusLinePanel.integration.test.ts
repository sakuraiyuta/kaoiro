// @vitest-environment jsdom
// The status line block of the member detail view (issue 514): the head drawn
// as markdown with the full profile, a way to the change log, and nothing at all
// when the card would draw nothing.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StatusLinePanel from "../src/lib/StatusLinePanel.svelte";
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

async function render(view: StatusLineView, onOpenHistory?: () => void): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(StatusLinePanel, { target, props: { view, onOpenHistory } }));
  await tick();
  return target;
}

describe("StatusLinePanel", () => {
  it("draws nothing when the card would draw nothing", async () => {
    const target = await render({ kind: "none" }, () => {});

    expect(target.querySelector(".status-line-panel")).toBeNull();
    expect(target.textContent).toBe("");
  });

  it("says 未設定 for an agent known to have no line", async () => {
    const target = await render({ kind: "unset" });

    expect(target.querySelector(".unset")?.textContent).toBe("未設定");
    expect(target.querySelector(".body")).toBeNull();
  });

  it("draws the head as markdown with real links, the time, and how long ago", async () => {
    const head = "# 作業中\n\n**issue** [#482](https://github.com/o/r/issues/482)\n\n- a\n- b";
    const target = await render(setLine({ head, bytes: head.length }));

    expect(target.querySelector(".body h1")?.textContent).toBe("作業中");
    expect(target.querySelector(".body strong")?.textContent).toBe("issue");
    expect(target.querySelectorAll(".body li")).toHaveLength(2);
    const link = target.querySelector<HTMLAnchorElement>(".body a")!;
    expect(link.getAttribute("href")).toBe("https://github.com/o/r/issues/482");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(target.querySelector("time")?.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(target.querySelector("time")?.getAttribute("title")).toBe("30 分前");
  });

  it("keeps only http(s) as links and makes no image or script from hostile text", async () => {
    const head =
      "<script>window.__pwned = 1</script>\n\n<img src=x onerror=alert(1)> [js](javascript:alert(1)) ![p](https://evil.test/p.png) [ok](https://e.test/)";
    const target = await render(setLine({ head, bytes: head.length }));

    expect(target.querySelector("script, img, iframe")).toBeNull();
    const hrefs = Array.from(target.querySelectorAll("a"), (a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://evil.test/p.png", "https://e.test/"]);
    expect(target.textContent).toContain("<img src=x onerror=alert(1)>");
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it("shows raw HTML after an inline code tag as text, not as elements", async () => {
    const head = "<kbd>k <strong/x>bold <span/class=md-link>fake link";
    const target = await render(setLine({ head, bytes: head.length }));

    expect(target.querySelector(".body strong, .body span, .body kbd")).toBeNull();
    expect(target.querySelector(".body")?.textContent).toContain("<span/class=md-link>fake link");
  });

  it("offers 続きを読む and the size only when the server cut the head", async () => {
    const cut = await render(setLine({ truncated: true, bytes: 2048 }), () => {});
    const whole = await render(setLine(), () => {});

    expect(cut.querySelector(".more")?.textContent).toBe("…続きあり (2.0 KB)");
    expect(cut.querySelector(".read-more")?.textContent).toBe("続きを読む");
    expect(whole.querySelector(".more")).toBeNull();
    expect(whole.querySelector(".read-more")).toBeNull();
  });

  it("opens the change log from both buttons, and from neither when nothing can open it", async () => {
    const open = vi.fn();
    const cut = await render(setLine({ truncated: true, bytes: 2048 }), open);
    cut.querySelector<HTMLButtonElement>(".read-more")!.click();
    cut.querySelector<HTMLButtonElement>(".history")!.click();
    expect(open).toHaveBeenCalledTimes(2);

    const none = await render(setLine({ truncated: true, bytes: 2048 }));
    expect(none.querySelector("button")).toBeNull();
  });

  it("offers the change log for a cleared line too", async () => {
    const open = vi.fn();
    const target = await render({ kind: "unset" }, open);

    target.querySelector<HTMLButtonElement>(".history")!.click();

    expect(open).toHaveBeenCalledTimes(1);
  });
});
