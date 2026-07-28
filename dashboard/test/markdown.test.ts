// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown, sanitizeMermaidSvg } from "../src/lib/markdown";

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
