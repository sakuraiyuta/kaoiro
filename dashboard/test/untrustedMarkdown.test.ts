// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/lib/markdown";
import {
  inlineLineCount,
  inlineMarkdownToHtml,
  MAX_NESTING_DEPTH,
  renderUntrustedInline,
  renderUntrustedMarkdown,
  sanitizeUntrustedHtml,
  sanitizeUntrustedInlineHtml,
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

// The inline profile (issue 514): the agent card draws a status line inside a
// button, so only phrasing content may come out and a link is text.
describe("inline profile: layer one (the string marked emits, before sanitizing)", () => {
  it.each([
    ["emphasis, strike and code", "**b** *i* ~~d~~ `c`", "<strong>b</strong> <em>i</em> <del>d</del> <code>c</code>"],
    ["an http(s) link as underlined text, never an anchor", "[#482](https://example.test/x)", '<span class="md-link">#482</span>'],
    ["a link that is not http(s) as its bare label", "[x](javascript:alert(1))", "x"],
    ["a data link as its bare label", "[x](data:text/plain;base64,eA==)", "x"],
    ["an image as its alt text alone", "![alt](https://e.test/p.png)", "alt"],
    ["a heading as bold text", "# Title\ntext", "<strong>Title</strong><br>text"],
    ["a bullet list as lines", "- a\n- b", "・a<br>・b"],
    ["an ordered list with its first number", "3. c\n4. d", "3. c<br>4. d"],
    ["task ticks as text", "- [x] a\n- [ ] b", "・[x] a<br>・[ ] b"],
    ["a blockquote as its content", "> q\n> r", "q<br>r"],
    ["a fenced block as code with breaks", "```js\nl1\nl2\n```", "<code>l1<br>l2</code>"],
    ["a table as rows of cells", "| a | b |\n|:-:|--:|\n| 1 | 2 |", "a | b<br>1 | 2"],
    ["a nested list on its own line", "- a\n  - b", "・a<br>・b"],
    ["a loose list without a blank line", "- a\n\n- b", "・a<br>・b"],
    ["an empty list item as a line of its own", "-\n- b", "・<br>・b"],
    ["a list followed by a paragraph", "- a\n- b\n\ntext", "・a<br>・b<br>text"],
    ["a blank line inside a code block as one break", "```\na\n\nb\n```", "<code>a<br>b</code>"],
    ["an image alt that spans lines as one line", "![a\nb](https://e.test/p.png)", "a b"],
    ["a rule as nothing", "a\n\n---\n\nb", "a<br>b"],
    ["paragraphs as one line each", "a\n\nb\n\nc", "a<br>b<br>c"],
    ["a single newline as a break", "a\nb", "a<br>b"],
  ])("draws %s", (_name, source, html) => {
    expect(inlineMarkdownToHtml(source)).toBe(html);
  });

  it.each([
    ["a script and an img", "<script>alert(1)</script><img src=x onerror=alert(1)>"],
    ["a bold tag", "<b>x</b>"],
    ["an anchor", '<a href="javascript:alert(1)">x</a>'],
    ["an iframe", '<iframe src="https://e.test/"></iframe>'],
    ["a multi-line block", "<div>\nline\n</div>"],
  ])("shows raw HTML as the text the author wrote: %s", (_name, source) => {
    const html = inlineMarkdownToHtml(source);

    expect(html).not.toMatch(/<(?!br>)/);
    expect(html).toContain("&lt;");
    expect(html).not.toContain("\n");
  });

  it("never emits an anchor, an image or a newline, whatever the source", () => {
    for (const source of HOSTILE_CORPUS) {
      const html = inlineMarkdownToHtml(source);

      expect(html, source).not.toMatch(/<a[\s>]/i);
      expect(html, source).not.toMatch(/<img/i);
      expect(html, source).not.toMatch(/<(script|iframe|svg|style|form|input)/i);
      expect(html, source).not.toContain("\n");
    }
  });
});

describe("inline profile: layer two on its own", () => {
  function sanitized(html: string): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = sanitizeUntrustedInlineHtml(html);
    return root;
  }

  it("keeps the six tags", () => {
    const root = sanitized("<strong>a</strong><em>b</em><code>c</code><del>d</del>e<br>f<span>g</span>");

    expect(root.innerHTML).toBe("<strong>a</strong><em>b</em><code>c</code><del>d</del>e<br>f<span>g</span>");
  });

  it("strips every other tag, keeping an anchor's label", () => {
    const root = sanitized(
      '<a href="https://ok.example/">label</a><img src="https://e.test/x.png" alt="alt"><script>alert(1)</script>' +
        "<iframe></iframe><h1>h</h1><ul><li>l</li></ul><table><tr><td>t</td></tr></table><p>p</p>",
    );

    for (const tag of ["a", "img", "script", "iframe", "h1", "ul", "li", "table", "p"]) {
      expect(root.querySelector(tag), tag).toBeNull();
    }
    expect(root.textContent).toContain("label");
  });

  it("strips handlers, style, id, title, role and tabindex", () => {
    const span = sanitized(
      '<span class="md-link" onclick="alert(1)" style="position:fixed" id="x" title="t" role="button" tabindex="0">s</span>',
    ).querySelector("span")!;

    expect(Array.from(span.attributes).map((a) => a.name)).toEqual(["class"]);
  });

  it("strips data-* attributes", () => {
    const span = sanitized('<span class="md-link" data-agent-id="x" data-x="1">s</span>').querySelector("span")!;

    expect(span.getAttributeNames()).toEqual(["class"]);
  });

  it("strips aria-* attributes", () => {
    const span = sanitized('<span class="md-link" aria-label="spoof" aria-hidden="true">s</span>').querySelector("span")!;

    expect(span.getAttributeNames()).toEqual(["class"]);
  });

  it("keeps the class only when it is exactly md-link on a span", () => {
    const root = sanitized(
      '<span class="evil">a</span><span class="md-link extra">b</span><span class="md-link">c</span><strong class="md-link">d</strong><code class="md-link">e</code>',
    );

    expect(root.querySelector('span:nth-of-type(1)')!.hasAttribute("class")).toBe(false);
    expect(root.querySelector('span:nth-of-type(2)')!.hasAttribute("class")).toBe(false);
    expect(root.querySelector('span:nth-of-type(3)')!.getAttribute("class")).toBe("md-link");
    expect(root.querySelector("strong")!.hasAttribute("class")).toBe(false);
    expect(root.querySelector("code")!.hasAttribute("class")).toBe(false);
  });

  it("leaves the full profile's own purifier as it was", () => {
    sanitizeUntrustedInlineHtml('<span class="md-link">x</span>');
    const root = document.createElement("div");
    root.innerHTML = sanitizeUntrustedHtml(
      '<pre><code class="language-js">x</code></pre><a href="https://ok.example/">l</a><span data-x="1">s</span>',
    );

    expect(root.querySelector("code")?.getAttribute("class")).toBe("language-js");
    expect(root.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(root.querySelector("span")?.getAttribute("data-x")).toBe("1");
  });
});

describe("inline profile: the composed render", () => {
  function elements(html: string): Element[] {
    const root = document.createElement("div");
    root.innerHTML = html;
    return Array.from(root.querySelectorAll("*"));
  }

  const ALLOWED = new Set(["STRONG", "EM", "CODE", "DEL", "BR", "SPAN"]);

  function assertAllowed(source: string): void {
    const rendered = renderUntrustedInline(source);
    if (rendered.kind !== "html") return;
    for (const el of elements(rendered.html)) {
      expect(ALLOWED.has(el.tagName), `${el.tagName} in ${JSON.stringify(source)}`).toBe(true);
      for (const name of el.getAttributeNames()) {
        expect(name, source).toBe("class");
        expect(el.tagName, source).toBe("SPAN");
        expect(el.getAttribute("class"), source).toBe("md-link");
      }
    }
    expect(rendered.html, source).not.toContain("\n");
  }

  it("renders a rich source as the allowed elements only", () => {
    const rendered = renderUntrustedInline("**テスト表示** [#482](https://github.com/o/r/issues/482) と `code`");

    expect(rendered).toEqual({
      kind: "html",
      html: '<strong>テスト表示</strong> <span class="md-link">#482</span> と <code>code</code>',
    });
  });

  it("draws only real links as links: the card and the dialog agree", () => {
    const source = "[ok](https://e.test/) [js](javascript:alert(1)) [rel](/x) [mail](mailto:a@b.c)";
    const card = renderUntrustedInline(source);
    const dialog = renderUntrustedMarkdown(source);

    expect(card.kind === "html" && card.html.match(/md-link/g)?.length).toBe(1);
    expect(dialog.kind === "html" && dialog.html.match(/<a /g)?.length).toBe(1);
  });

  it("keeps only the allowed elements for every hostile source", () => {
    for (const source of HOSTILE_CORPUS) assertAllowed(source);
  });

  it("keeps them for the source cut at every code point, as a cut head would be", () => {
    // The server cuts at grapheme boundaries; every code-point prefix is a
    // superset of any Unicode version's graphemes, so no cut can be missed.
    for (const source of CUT_CORPUS) {
      const points = Array.from(source);
      for (let end = 1; end <= points.length; end += 1) {
        const prefix = points.slice(0, end).join("");
        const started = performance.now();
        assertAllowed(prefix);
        // A generous ceiling: this catches a hang, not a slow machine.
        expect(performance.now() - started, prefix).toBeLessThan(2000);
      }
    }
  });

  it("keeps the allowed elements and holds no newline for generated sources", () => {
    // A fixed generator, so a failure names a source that can be replayed.
    const pieces = [
      "a", "b c", "\n", "\n\n", "# ", "- ", "1. ", "3. ", "> ", "```", "```js\n", "    ", "|", "|---|",
      "| x | y |", "**", "*", "~~", "`", "[l](https://e.test/)", "![i](https://e.test/p.png)", "![a\nb](x)",
      "<div>", "</div>", "<b>", "<!-- c -->", "---", "- [x] ", "\r\n", "  \n", "\\", "&amp;", "<https://e.test>",
    ];
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 1500; i += 1) {
      let source = "";
      for (let j = 1 + Math.floor(next() * 14); j > 0; j -= 1) {
        source += pieces[Math.floor(next() * pieces.length)];
      }
      assertAllowed(source);
      expect(inlineMarkdownToHtml(source), source).not.toMatch(/<br><br>|^<br>|<br>$/);
    }
  });

  it("is plain when the source draws nothing, so a summary is never empty", () => {
    for (const source of ["---", "***", "# ", "[ref]: https://e.test/", "```\n```", "> "]) {
      expect(renderUntrustedInline(source), source).toEqual({ kind: "plain" });
    }
    expect(renderUntrustedInline("a")).toMatchObject({ kind: "html" });
  });

  it("switches exactly at the nesting limit, as the full profile does", () => {
    const quoted = (depth: number) => `${">".repeat(depth)} text`;

    expect(renderUntrustedInline(quoted(MAX_NESTING_DEPTH))).toMatchObject({ kind: "html" });
    expect(renderUntrustedInline(quoted(MAX_NESTING_DEPTH + 1))).toEqual({ kind: "plain" });
    expect(renderUntrustedInline(">".repeat(3000))).toEqual({ kind: "plain" });
  });

  it("does not change what the full profile or its sanitizer emit", () => {
    const before = renderUntrustedMarkdown(CHAT_FIXTURE);
    renderUntrustedInline(CHAT_FIXTURE);

    expect(renderUntrustedMarkdown(CHAT_FIXTURE)).toEqual(before);
    expect(renderMarkdown(CHAT_FIXTURE)).toBe(CHAT_BEFORE);
  });

  it("counts the lines it draws: paragraphs are lines, blank source lines are not", () => {
    const lines = (source: string) => inlineLineCount(renderUntrustedInline(source), source);

    expect(lines("one")).toBe(1);
    expect(lines("a\n\nb\n\nc")).toBe(3);
    expect(lines("a\nb\nc\nd")).toBe(4);
    expect(lines("# h\n- a\n- b\ntext")).toBe(4);
    expect(inlineLineCount({ kind: "plain" }, "a\nb\nc")).toBe(3);
  });
});

const HOSTILE_CORPUS = [
  '<script>window.__pwned = "script"</script>',
  "<img src=\"https://evil.test/raw.png\" onerror=\"window.__pwned = 'onerror'\">",
  "![tracking pixel](https://evil.test/pixel.png)",
  "[run me](javascript:window.__pwned='link')",
  "[inline data](data:text/plain;base64,eA==)",
  '<a href="javascript:window.__pwned=\'raw-anchor\'">raw anchor</a>',
  "<iframe src=\"https://evil.test/\"></iframe><style>a{}</style><svg><circle/></svg><form><input></form>",
  "# heading\n\n- [x] done\n- [ ] todo\n\n3. three\n\n> quote\n\n---\n\n| a | b |\n|:-:|--:|\n| 1 | 2 |",
  "```js\nlet a = 1;\n```\n\n    indented code\n\n<div>\nblock\n</div>",
  "**bold *nested ~~strike `code` [link](https://e.test/) ![img](https://e.test/i.png)** x",
  "[a](<javascript:alert(1)>) [b](&#106;avascript:alert(1)) <https://e.test/auto> https://bare.test/ www.bare.test",
  "line one  \nline two\\\nline three\r\nline four",
  "\u0000\u0001 control ‮ rtl ​ zero-width",
];

const CUT_CORPUS = [
  "**bold [#482](https://github.com/sakuraiyuta/kaoiro/issues/482) と `code` ![alt](https://e.test/p.png)",
  "# 作業中\n- [x] 設計 😀👨‍👩‍👧\n- [ ] 実装\n3. 三\n> 引用\n| a | b |\n|:-:|--:|\n| 1 | 2 |",
  "```js\nlet a = 1;\n```\n<script>alert(1)</script><img src=x onerror=alert(1)> [x](javascript:alert(1))",
  "é \u{1F468}‍\u{1F469}‍\u{1F467} **強調 ~~取り消し~~** <b>raw</b>\n\n本文",
];
