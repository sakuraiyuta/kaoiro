import "./isolation.setup";
// @vitest-environment jsdom
import DOMPurify from "dompurify";
import { marked } from "marked";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown, sanitizeMermaidSvg } from "../src/lib/markdown";
import { MAX_NESTING_DEPTH } from "../src/lib/untrustedMarkdown";

describe("renderMarkdown", () => {
  it("markdown を HTML に整形する", () => {
    const html = renderMarkdown("# 見出し\n\n- a\n- b");
    expect(html).toContain("<h1");
    expect(html).toContain("<li>a</li>");
  });

  it("コードブロックを pre/code にする", () => {
    const html = renderMarkdown("```\ncode\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code>");
  });

  it("XSS を除去する (script / イベントハンドラ / javascript:)", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).not.toContain(
      "<script",
    );
    expect(renderMarkdown("<img src=x onerror=alert(1)>")).not.toContain(
      "onerror",
    );
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain(
      "javascript:",
    );
  });

  it("SVG / MathML / data-URI の mutation ベクタも除去する", () => {
    const svg = renderMarkdown("<svg><script>alert(1)</script></svg>");
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("alert");

    const math = renderMarkdown(
      "<math><mtext><script>alert(1)</script></mtext></math>",
    );
    expect(math).not.toContain("<script");

    expect(
      renderMarkdown("[x](data:text/html,<script>alert(1)</script>)"),
    ).not.toContain("data:text/html");
  });

  it("raw HTML の style attribute と style tag を除去して画面 overlay を防ぐ", () => {
    const html = renderMarkdown(
      '<style>body{display:none}</style><a href="/session" style="position:fixed;inset:0;z-index:9999">open</a>',
    );
    expect(html).not.toContain("<style");
    expect(html).not.toContain("style=");
    expect(html).toContain('href="/session"');
  });

  it("Mermaid SVG は別policyで style を残しつつ handler を除去する", () => {
    const svg = sanitizeMermaidSvg(
      '<svg><style>.node{fill:red}</style><rect onclick="alert(1)" /></svg>',
    );
    expect(svg).toContain("<style>.node{fill:red}</style>");
    expect(svg).not.toContain("onclick");
  });
});

// What renderMarkdown computed before the nesting guard: one marked.parse call
// and the sanitizer policy of markdown.ts (mirrored here on purpose, so a
// change to either has to be made knowingly). Ordinary input must still equal it.
const POLICY = { FORBID_ATTR: ["style"], FORBID_TAGS: ["style"] };
const previousRender = (text: string): string =>
  DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true }), POLICY);

const ORDINARY: Record<string, string> = {
  heading: "# Title\n\ntext",
  bullet_list: "- a\n- b\n  - c",
  ordered_list: "1. a\n2. b",
  code_fence: "```js\nconst a = 1;\n```",
  inline_code: "use `x` here",
  blockquote: "> quoted\n> more",
  table: "| a | b |\n|---|---|\n| 1 | 2 |",
  single_newline: "line one\nline two",
  crlf_newline: "line one\r\nline two",
  bare_url: "see https://example.com/path for details",
  strikethrough: "~~gone~~ kept",
  task_list: "- [x] done\n- [ ] todo",
  link: "[label](https://example.com)",
  javascript_link: "[x](javascript:alert(1))",
  image: "![alt](https://example.com/a.png)",
  raw_html: '<div class="a">raw</div>',
  script: "<script>alert(1)</script>",
  img_onerror: "<img src=x onerror=alert(1)>",
  emphasis: "*em* **strong** _em2_ __strong2__",
  hr: "a\n\n---\n\nb",
  entity: "a &copy; b &amp; c",
  mermaid_fence: "```mermaid\ngraph TD; A-->B;\n```",
  japanese: "日本語の段落です。\n二行目です。",
  nested_quote_list: "> - a\n>   - b\n> > deeper",
};

const quote = (depth: number): string => ">".repeat(depth);
const nestedList = (depth: number): string =>
  Array.from({ length: depth }, (_, i) => `${"  ".repeat(i)}- item`).join("\n");

describe("renderMarkdown output for ordinary input", () => {
  // Passing marked's lexer and parser only { breaks: true } drops its defaults
  // (gfm among them); 8 of these 24 inputs then differ.
  it.each(Object.entries(ORDINARY))("is unchanged for %s", (_name, text) => {
    expect(renderMarkdown(text)).toBe(previousRender(text));
  });
});

describe("renderMarkdown on nesting that is too deep", () => {
  it("shows the issue's 3,000-level quote as escaped text, without throwing", () => {
    const html = renderMarkdown(quote(3000));
    expect(html).not.toContain("<blockquote");
    expect(html).toContain("&gt;".repeat(3000));
  });

  it("shows a quote that overflows the lexer's stack as escaped text", () => {
    const html = renderMarkdown(quote(100_000));
    expect(html).not.toContain("<blockquote");
    expect(html).toContain("&gt;".repeat(100_000));
  });

  it("renders quotes and lists at the limit and falls back one level above", () => {
    expect(MAX_NESTING_DEPTH).toBe(32);
    expect(renderMarkdown(quote(MAX_NESTING_DEPTH))).toContain("<blockquote");
    expect(renderMarkdown(nestedList(MAX_NESTING_DEPTH))).toContain("<ul");
    expect(renderMarkdown(quote(MAX_NESTING_DEPTH + 1))).toBe(
      `<p>${"&gt;".repeat(MAX_NESTING_DEPTH + 1)}</p>`,
    );
    const list = renderMarkdown(nestedList(MAX_NESTING_DEPTH + 1));
    expect(list).not.toContain("<ul");
    expect(list).toContain("- item");
  });

  it("escapes the source it shows", () => {
    const html = renderMarkdown(`${"> ".repeat(40)}<script>alert(1)</script> & "q" 'r'`);
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp; &quot;q&quot; &#39;r&#39;");
  });

  it("keeps each line break of the source as one <br>", () => {
    const html = renderMarkdown(`${quote(40)} a\r\nb\nc`);
    expect(html.match(/<br>/g)).toHaveLength(2);
    expect(html).not.toContain("\n");
  });
});

describe("renderMarkdown checks depth before the parser and the sanitizer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("skips the parser and the sanitizer for quotes and lists past the limit", () => {
    const parse = vi.spyOn(marked, "parser");
    const sanitize = vi.spyOn(DOMPurify, "sanitize");
    expect(renderMarkdown(quote(MAX_NESTING_DEPTH + 1))).toBe(
      `<p>${"&gt;".repeat(MAX_NESTING_DEPTH + 1)}</p>`,
    );
    const list = renderMarkdown(nestedList(MAX_NESTING_DEPTH + 1));
    expect(list).not.toContain("<ul");
    expect(list).toContain("- item");
    expect(parse).not.toHaveBeenCalled();
    expect(sanitize).not.toHaveBeenCalled();
  });

  it("calls the parser and the sanitizer once each within the limit", () => {
    const parse = vi.spyOn(marked, "parser");
    const sanitize = vi.spyOn(DOMPurify, "sanitize");
    expect(renderMarkdown(quote(MAX_NESTING_DEPTH))).toContain("<blockquote");
    expect(parse).toHaveBeenCalledTimes(1);
    expect(sanitize).toHaveBeenCalledTimes(1);
  });
});

describe("renderMarkdown when a stage of the pipeline throws", () => {
  afterEach(() => vi.restoreAllMocks());

  const fallback = "<p>a &lt; b<br>c</p>";

  it("falls back to escaped text when the lexer throws", () => {
    vi.spyOn(marked, "lexer").mockImplementation(() => {
      throw new Error("lexer failed");
    });
    expect(renderMarkdown("a < b\nc")).toBe(fallback);
  });

  it("falls back to escaped text when the parser throws", () => {
    vi.spyOn(marked, "parser").mockImplementation(() => {
      throw new Error("parser failed");
    });
    expect(renderMarkdown("a < b\nc")).toBe(fallback);
  });

  it("falls back to escaped text when the sanitizer throws, and does not call it again", () => {
    const sanitize = vi.spyOn(DOMPurify, "sanitize").mockImplementation(() => {
      throw new Error("sanitize failed");
    });
    expect(renderMarkdown("a < b\nc")).toBe(fallback);
    expect(sanitize).toHaveBeenCalledTimes(1);
  });
});
