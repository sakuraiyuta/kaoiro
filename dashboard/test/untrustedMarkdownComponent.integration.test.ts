// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import UntrustedMarkdown from "../src/lib/UntrustedMarkdown.svelte";
import { reactiveText } from "./reactiveText.svelte";

let component: ReturnType<typeof mount> | null = null;

function render(text: string, variant?: "full" | "inline"): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(UntrustedMarkdown, {
    target,
    props: variant === undefined ? { text } : { text, variant },
  });
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

describe("UntrustedMarkdown, inline variant (the agent card)", () => {
  it("draws phrasing content in span wrappers only, so it can sit inside a button", async () => {
    const target = render("# T\n\n**b** [x](https://e.test/)\n\n- item", "inline");
    await tick();

    expect(target.querySelector("div, p, a, button, input, h1, ul, li, table")).toBeNull();
    expect(target.querySelector("span.untrusted-markdown.inline")).not.toBeNull();
    expect(Array.from(target.querySelectorAll("strong"), (el) => el.textContent)).toEqual(["T", "b"]);
    expect(target.querySelector("span.md-link")?.textContent).toBe("x");
  });

  it("shows hostile markup as text and makes no anchor or image from it", async () => {
    const target = render("<img src=x onerror=alert(1)> [x](javascript:alert(1)) ![a](https://e.test/p.png)", "inline");
    await tick();

    expect(target.querySelector("img, a, script")).toBeNull();
    expect(target.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(target.textContent).toContain("a");
  });

  it("falls back to plain text in a span, with no note", async () => {
    const source = ">".repeat(40) + " <b>deep</b>";
    const target = render(source, "inline");
    await tick();

    expect(target.querySelector(".untrusted-markdown-note")).toBeNull();
    const plain = target.querySelector("span.untrusted-markdown.plain.inline")!;
    expect(plain.textContent).toBe(source);
    expect(plain.querySelector("b")).toBeNull();
    expect(target.querySelector("div, p")).toBeNull();
  });

  it("leaves the default variant as it was: block elements in a div", async () => {
    const target = render("# T\n\n[x](https://e.test/)");
    await tick();

    expect(target.querySelector("div.untrusted-markdown:not(.inline)")).not.toBeNull();
    expect(target.querySelector("h1")?.textContent).toBe("T");
    expect(target.querySelector("a")?.getAttribute("href")).toBe("https://e.test/");
  });
});

describe("where untrusted text becomes HTML", () => {
  const sources = import.meta.glob("../src/**/*.svelte", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  it("UntrustedMarkdown.svelte is the one {@html} site for untrusted text", () => {
    const own = sources["../src/lib/UntrustedMarkdown.svelte"]!;
    expect(own.match(/\{@html /g)).toHaveLength(1);

    // The chat renderer in AgentDetail is an older policy, listed as the only
    // other {@html}: it is always `renderMarkdown(...)`, never a status line.
    for (const [path, source] of Object.entries(sources)) {
      if (path.endsWith("/UntrustedMarkdown.svelte")) continue;
      for (const match of source.matchAll(/\{@html ([^}]*)\}/g)) {
        expect(`${path}: ${match[1]}`, path).toMatch(/AgentDetail\.svelte: renderMarkdown\(/);
      }
    }
  });
});
