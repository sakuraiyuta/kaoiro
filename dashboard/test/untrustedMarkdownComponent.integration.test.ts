// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import UntrustedMarkdown from "../src/lib/UntrustedMarkdown.svelte";
import { reactiveText } from "./reactiveText.svelte";

let component: ReturnType<typeof mount> | null = null;

function render(text: string): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(UntrustedMarkdown, { target, props: { text } });
  return target;
}

afterEach(() => {
  if (component !== null) unmount(component);
  component = null;
  document.body.innerHTML = "";
});

describe("UntrustedMarkdown", () => {
  it("renders markdown as sanitized html", async () => {
    const target = render("# Title\n\n[issue](https://github.com/o/r/issues/482)");
    await tick();

    expect(target.querySelector("h1")?.textContent).toBe("Title");
    expect(target.querySelector("a")?.getAttribute("href")).toBe("https://github.com/o/r/issues/482");
    expect(target.querySelector(".untrusted-markdown-note")).toBeNull();
  });

  it("shows hostile markup as text, with no element created from it", async () => {
    const target = render("<img src=x onerror=alert(1)> [x](javascript:alert(1))");
    await tick();

    expect(target.querySelector("img")).toBeNull();
    expect(target.querySelector("a")).toBeNull();
    expect(target.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("falls back to plain text with a note when the markdown cannot be rendered", async () => {
    const source = ">".repeat(40) + " <b>deep</b>";
    const target = render(source);
    await tick();

    expect(target.querySelector(".untrusted-markdown-note")?.textContent).toBe(
      "書式を表示できないため、そのまま表示しています",
    );
    const plain = target.querySelector(".untrusted-markdown.plain")!;
    // Svelte text interpolation: the source is text, so the tag is escaped.
    expect(plain.textContent).toBe(source);
    expect(plain.querySelector("b")).toBeNull();
    expect(plain.innerHTML).toContain("&lt;b&gt;");
  });

  it("follows a changed text", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const props = reactiveText("one");
    component = mount(UntrustedMarkdown, { target, props });
    await tick();
    expect(target.textContent).toContain("one");

    props.text = "**two**";
    await tick();

    expect(target.querySelector("strong")?.textContent).toBe("two");
  });
});
