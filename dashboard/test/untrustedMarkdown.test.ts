// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/lib/markdown";
import {
  MAX_NESTING_DEPTH,
  renderUntrustedMarkdown,
  sanitizeUntrustedHtml,
} from "../src/lib/untrustedMarkdown";

// What the chat renderer produces for a fixed input, taken before this module
// renders anything. The strict module must not change it afterwards.
const CHAT_FIXTURE =
  "# T\n\n[a](https://e.example/) ![i](https://e.example/x.png) <b>x</b>\n\n- one\n- two";
const CHAT_BEFORE = renderMarkdown(CHAT_FIXTURE);

/** Renders, requires html, and parses the result so assertions read the DOM. */
function htmlOf(source: string): HTMLElement {
  const rendered = renderUntrustedMarkdown(source);
  if (rendered.kind !== "html") throw new Error(`expected html for ${JSON.stringify(source)}`);
  const root = document.createElement("div");
  root.innerHTML = rendered.html;
  return root;
}

function anchors(root: HTMLElement): HTMLAnchorElement[] {
  return Array.from(root.querySelectorAll("a"));
}

describe("renderUntrustedMarkdown: layer one (marked)", () => {
  it("renders ordinary markdown", () => {
    const root = htmlOf("# Title\n\n- one\n- two\n\n`code`\n\n| a | b |\n|---|---|\n| 1 | 2 |");

    expect(root.querySelector("h1")?.textContent).toBe("Title");
    expect(root.querySelectorAll("li")).toHaveLength(2);
    expect(root.querySelector("code")?.textContent).toBe("code");
    expect(root.querySelector("table")).not.toBeNull();
  });

  it("keeps what GFM says: task ticks, a list's first number and column alignment", () => {
    const root = htmlOf(
      "- [x] done\n- [ ] todo\n\n3. three\n4. four\n\n| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |",
    );

    // A tick is text because an <input> is forbidden; done and todo differ.
    const items = Array.from(root.querySelectorAll("li")).map((li) => li.textContent);
    expect(items.slice(0, 2)).toEqual(["[x] done", "[ ] todo"]);
    expect(root.querySelector("input")).toBeNull();
    expect(root.querySelector("ol")?.getAttribute("start")).toBe("3");
    const aligns = Array.from(root.querySelectorAll("th")).map((th) => th.getAttribute("align"));
    expect(aligns).toEqual(["left", "center", "right"]);
  });

  it("shows the tick of a task in a loose list too", () => {
    const items = Array.from(htmlOf("- [x] a\n\n- [ ] b").querySelectorAll("li")).map(
      (li) => li.textContent?.trim(),
    );

    expect(items).toEqual(["[x] a", "[ ] b"]);
  });

  it("turns single newlines into line breaks", () => {
    expect(htmlOf("one\ntwo").querySelector("br")).not.toBeNull();
  });

  it("shows raw HTML as the text the author wrote, never as elements", () => {
    const root = htmlOf("<img src=x onerror=alert(1)> and <script>alert(1)</script> <b>bold</b>");

    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("b")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(root.textContent).toContain("<script>alert(1)</script>");
    expect(root.textContent).toContain("<b>bold</b>");
  });

  it.each([
    ["javascript:", "[x](javascript:alert(1))"],
    ["mixed case", "[x](JaVaScRiPt:alert(1))"],
    ["entity encoded", "[x](&#106;avascript:alert(1))"],
    ["data:", "[x](data:text/html;base64,PHNjcmlwdD4=)"],
    ["protocol relative", "[x](//evil.example/p)"],
    ["relative", "[x](/rel/path)"],
    ["mailto:", "[x](mailto:a@b.c)"],
    ["a reference definition", "[x][r]\n\n[r]: javascript:alert(1)"],
  ])("keeps only the label of a %s link", (_name, source) => {
    const root = htmlOf(source);

    expect(anchors(root)).toHaveLength(0);
    expect(root.textContent).toContain("x");
    expect(root.innerHTML).not.toMatch(/javascript:|data:|mailto:|evil\.example/i);
  });

  it("keeps an http(s) link, with the safe-attribute hook applied", () => {
    const [link] = anchors(htmlOf("[issue](https://github.com/o/r/issues/482)"));

    expect(link?.getAttribute("href")).toBe("https://github.com/o/r/issues/482");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.textContent).toBe("issue");
  });

  it("autolinks www and https text as http(s) anchors", () => {
    const links = anchors(htmlOf("see www.example.com and https://github.com/o/r/issues/482"));

    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "http://www.example.com/",
      "https://github.com/o/r/issues/482",
    ]);
  });

  it("shows an image as a link to its URL and never loads it", () => {
    const root = htmlOf("![the diagram](https://e.example/x.png)");

    expect(root.querySelector("img")).toBeNull();
    const [link] = anchors(root);
    expect(link?.getAttribute("href")).toBe("https://e.example/x.png");
    expect(link?.textContent).toBe("the diagram");
  });

  it("shows an image whose URL is not http(s) as its alt text alone", () => {
    const root = htmlOf("![the diagram](javascript:alert(1)) ![d](data:image/png;base64,AAAA)");

    expect(root.querySelector("img")).toBeNull();
    expect(anchors(root)).toHaveLength(0);
    expect(root.textContent).toContain("the diagram");
  });
});

describe("sanitizeUntrustedHtml: layer two on its own", () => {
  function sanitized(html: string): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = sanitizeUntrustedHtml(html);
    return root;
  }

  it.each([
    ["mailto:", '<a href="mailto:a@b.c">m</a>'],
    ["a relative path", '<a href="/rel">r</a>'],
    ["a protocol-relative URL", '<a href="//evil.example/p">p</a>'],
    ["javascript:", '<a href="javascript:alert(1)">j</a>'],
    ["data:", '<a href="data:text/html;base64,PHNjcmlwdD4=">d</a>'],
  ])("strips the href of an anchor with %s", (_name, html) => {
    const [link] = anchors(sanitized(html));

    expect(link?.hasAttribute("href") ?? false).toBe(false);
  });

  it("keeps a list's start number and a cell's alignment, which are not URLs", () => {
    const root = sanitized('<ol start="3"><li>x</li></ol><table><tr><td align="right">c</td></tr></table>');

    expect(root.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(root.querySelector("td")?.getAttribute("align")).toBe("right");
  });

  it("keeps an https anchor and adds rel and target", () => {
    const [link] = anchors(sanitized('<a href="https://ok.example/">ok</a>'));

    expect(link?.getAttribute("href")).toBe("https://ok.example/");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("removes images, styles, svg, math, frames, forms, inputs, style attributes and handlers", () => {
    const root = sanitized(
      '<img src="https://e.example/x.png"><style>a{}</style><svg><circle/></svg><math><mi>x</mi></math>' +
        '<iframe src="https://e.example/"></iframe><form action="/x"><input name="n"></form>' +
        '<p style="position:fixed" onclick="alert(1)">kept</p>',
    );

    for (const tag of ["img", "style", "svg", "math", "iframe", "form", "input"]) {
      expect(root.querySelector(tag), tag).toBeNull();
    }
    const p = root.querySelector("p");
    expect(p?.textContent).toBe("kept");
    expect(p?.hasAttribute("style")).toBe(false);
    expect(p?.hasAttribute("onclick")).toBe(false);
  });
});

describe("failure is bounded", () => {
  it("falls back to plain text when the parser throws on very deep nesting", () => {
    expect(renderUntrustedMarkdown(">".repeat(3000))).toEqual({ kind: "plain" });
  });

  it("falls back to plain text above the nesting limit and renders at it", () => {
    expect(MAX_NESTING_DEPTH).toBe(32);
    expect(renderUntrustedMarkdown(">".repeat(40))).toEqual({ kind: "plain" });
    expect(renderUntrustedMarkdown(">".repeat(30))).toMatchObject({ kind: "html" });
  });

  it("counts list nesting too", () => {
    const nested = (depth: number) =>
      Array.from({ length: depth }, (_, i) => `${"  ".repeat(i)}- item`).join("\n");

    expect(renderUntrustedMarkdown(nested(40))).toEqual({ kind: "plain" });
    expect(renderUntrustedMarkdown(nested(10))).toMatchObject({ kind: "html" });
  });

  it("switches exactly at the limit: 32 levels render and 33 do not", () => {
    const nested = (depth: number) =>
      Array.from({ length: depth }, (_, i) => `${"  ".repeat(i)}- item`).join("\n");

    expect(renderUntrustedMarkdown(">".repeat(MAX_NESTING_DEPTH))).toMatchObject({ kind: "html" });
    expect(renderUntrustedMarkdown(">".repeat(MAX_NESTING_DEPTH + 1))).toEqual({ kind: "plain" });
    expect(renderUntrustedMarkdown(nested(MAX_NESTING_DEPTH))).toMatchObject({ kind: "html" });
    expect(renderUntrustedMarkdown(nested(MAX_NESTING_DEPTH + 1))).toEqual({ kind: "plain" });
  });

  it("never throws, whatever the input", () => {
    for (const source of ["", "\u0000", "<".repeat(20000), "*a _b".repeat(200), "[".repeat(5000)]) {
      expect(() => renderUntrustedMarkdown(source)).not.toThrow();
    }
  });
});

describe("the chat renderer is untouched", () => {
  it("renders the same bytes after this module has rendered", () => {
    renderUntrustedMarkdown(CHAT_FIXTURE);
    renderUntrustedMarkdown("[a](https://e.example/) ![i](https://e.example/x.png) <b>x</b>");

    expect(renderMarkdown(CHAT_FIXTURE)).toBe(CHAT_BEFORE);
  });

  it("still passes images and has none of this module's anchor attributes", () => {
    const chat = renderMarkdown(CHAT_FIXTURE);

    expect(chat).toContain("<img");
    expect(chat).not.toContain("noopener noreferrer nofollow");
    expect(chat).not.toContain('target="_blank"');
  });
});
