// The oracle and the corpora for the trim of a truncated status line head
// (issue 514). For a start P of the full line F, what P draws must be a start
// of what F draws, and every link P draws must be a link F draws. Both
// renderers are the production ones: the full profile of the detail view and
// the inline profile of the card. Needs a DOM (jsdom).
import { renderUntrustedInline, renderUntrustedMarkdown } from "../src/lib/untrustedMarkdown";

export type Profile = "full" | "inline";
export const PROFILES: readonly Profile[] = ["full", "inline"];

/** `delim-hidden`: a delimiter only F draws is missing from P (benign, counted).
 *  `delim-extra`: a raw delimiter only P draws (harmful). `text`: any other
 *  difference. `href`: a link P draws that F does not. */
export type Leak = "text" | "href" | "delim-extra" | "delim-hidden";

type Drawn = { text: string; hrefs: string[] };

const memo = new Map<string, Drawn>();

/** What a renderer draws for `text`: its text without blanks and list dots,
 *  and the address of every link. The plain fallback draws the source. */
function draw(profile: Profile, text: string): Drawn {
  const key = `${profile}\0${text}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const rendered = profile === "full" ? renderUntrustedMarkdown(text) : renderUntrustedInline(text);
  let drawn: Drawn;
  if (rendered.kind === "plain") {
    drawn = { text: text.replace(/\s+/g, ""), hrefs: [] };
  } else {
    const scratch = document.createElement("div");
    scratch.innerHTML = rendered.html;
    drawn = {
      text: (scratch.textContent ?? "").replace(/[\s・]+/g, ""),
      hrefs: Array.from(scratch.querySelectorAll("a"), (a) => a.getAttribute("href") ?? ""),
    };
  }
  if (memo.size > 4000) memo.clear();
  memo.set(key, drawn);
  return drawn;
}

const DELIMITERS = /[*_~`[\]]/;

/** Aligns P against F character by character and names the worst difference:
 *  a delimiter only F has is hidden, one only P has is extra, anything else
 *  is text. */
function classify(p: string, f: string): Leak {
  let i = 0;
  let j = 0;
  let hidden = 0;
  let extra = 0;
  while (i < p.length) {
    if (j >= f.length) return "text";
    if (p[i] === f[j]) {
      i++;
      j++;
    } else if (DELIMITERS.test(f[j]!) && !DELIMITERS.test(p[i]!)) {
      hidden++;
      j++;
    } else if (DELIMITERS.test(p[i]!) && !DELIMITERS.test(f[j]!)) {
      extra++;
      i++;
    } else {
      return "text";
    }
  }
  return extra > 0 ? "delim-extra" : hidden > 0 ? "delim-hidden" : "text";
}

/** Null when `shown` draws faithfully against the full line, else the reason. */
export function leak(profile: Profile, full: string, shown: string): Leak | null {
  const f = draw(profile, full);
  const p = draw(profile, shown);
  if (!f.text.startsWith(p.text)) return classify(p.text, f.text);
  for (const href of p.hrefs) if (!f.hrefs.includes(href)) return "href";
  return null;
}

export function graphemeEnds(text: string): number[] {
  const ends: number[] = [];
  for (const g of new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text)) {
    ends.push(g.index + g.segment.length);
  }
  return ends;
}

export type Tally = {
  cuts: number;
  notIdempotent: number;
  full: Record<string, number>;
  inline: Record<string, number>;
};

/** Every grapheme cut of every document, judged in both profiles; with `every`
 *  above 1, every that-many-th cut of each document. */
export function tally(docs: readonly string[], trim: (head: string) => string, every = 1): Tally {
  const out: Tally = { cuts: 0, notIdempotent: 0, full: {}, inline: {} };
  for (const doc of docs) {
    for (const [i, end] of graphemeEnds(doc).entries()) {
      if (end >= doc.length || i % every !== 0) continue;
      const shown = trim(doc.slice(0, end));
      out.cuts++;
      if (trim(shown) !== shown) out.notIdempotent++;
      for (const profile of PROFILES) {
        const kind = leak(profile, doc, shown) ?? "ok";
        out[profile][kind] = (out[profile][kind] ?? 0) + 1;
      }
    }
  }
  return out;
}

// ---- the corpora ----

const GITHUB = "https://github.com/sakuraiyuta/kaoiro/issues/214";

/** The shapes of a status line head, one construct each. */
export const SYNTHETIC: readonly string[] = [
  "**状況**\n- [issue 214 の設計レビュー依頼](https://github.com/sakuraiyuta/kaoiro/issues/214) を待機\n- 次の作業",
  "担当は [issue 214](https://github.com/sakuraiyuta/kaoiro/issues/214) の配送相談役だけ。返事待ちはありません",
  "**状況**\n- **この点はとても重要です** と言える\n- 次",
  "これは **この点はとても重要です** という話で、続きがあります",
  "手順:\n- `pnpm test --filter dashboard` を実行\n- 次",
  "実行は `pnpm test --filter dashboard` の順で、続きがあります",
  "手順:\n```ts\nconst a = 1;\nconst b = [1, 2];\n```\n終わりの文",
  "- 一つ目の項目\n- 二つ目の項目です\n- 三つ目",
  "1. 一つ目の項目\n2. 二つ目の項目です\n3. 三つ目",
  "日本語の長い文章です。👨‍👩‍👧‍👦 家族の絵文字と é を含む。🇯🇵 国旗の後ろにも続く文があります。",
  "| a | b |\n|---|---|\n| c | d |\n| e | f |",
  "## 見出し\n**太字の説明が続きます** と本文",
  "> 引用の一行目\n> 引用の二行目です\n\n本文",
  "参照: https://github.com/sakuraiyuta/kaoiro/issues/514 を見てください",
  "AT&amp;T と &copy; の話、続き",
  "a \\* b \\[c\\] d と続く",
  "**強調が改行を\nまたぐ** 後ろの文",
  "arr[0] と 2 * 3 と snake_case_name を含む文、続き",
];

/** Documents whose cuts fall inside an address, behind a filler line. */
export const ADDRESSES: readonly string[] = [
  "x https://example.com/abc`code` y and more text",
  "x https://example.com/a.html y and more",
  "**https://example.com/abcdef** tail",
  "[![alt](https://e.com/i.png)](https://example.com/target) t",
  "[a](https://example.com/a_(b)_c) tail",
  '[a](https://example.com/x "title") tail',
  "<https://example.com/abcdef> tail",
  "[a](<https://example.com/x y>) tail",
  "\\[not link\\](https://example.com/q) tail",
  "[arr[0]](https://example.com/z) tail",
  "mail foo@example.com tail",
  "see www.example.com/abc tail",
  "_https://example.com/a_b_ tail",
  "> - [lab](https://example.com/zz) tail",
  "[a<b](https://example.com/q) tail",
  "~~https://example.com/abc~~ tail",
  "`[a](` then https://example.com/x tail",
  "(see https://example.com/a) tail",
  "[`a]b`](https://example.com/q) tail",
  "![alt text](https://example.com/i.png) tail",
  "**見出し [issue 518](https://example.com/518)** 本文 https://example.com/zz 続き",
  "前文。\n**[issue 1](https://example.com/1) と https://example.com/2 の件",
  "*a https://example.com/abc* tail",
  "x https://example.com/abc_ tail",
  "x https://example.com/abc. tail",
  "x https://example.com/abc), tail",
];

/** Block structures the lexer decides, each of which the trim must leave alone
 *  or cut cleanly. */
export const STRUCTURES: readonly string[] = [
  "見出しの文\n---\n本文が続く、少し長めに書いておく。",
  "見出しの文\n===\n本文が続く、少し長めに書いておく。",
  "前の文\n\n---\n\n後の文が続く。",
  "<div>ブロック HTML の中身</div>\n\n後の文が続く。",
  "- 親項目 **強調**\n  - 子項目 [link](https://example.com/a)\n    - 孫項目 `code`\n- 次の親",
  "> - 引用の中のリスト **太字** と [link](https://example.com/q)\n> - 次の項目",
  "文の前\n\n    const a = 1;\n    const b = [1, 2];\n\n文の後",
  "- [ ] 未完了の項目 **強調**\n- [x] 完了した項目 [link](https://example.com/t)",
  "## 見出し **強調** ##\n本文が続く。",
  "最初の行 **太字**\r\n次の行 [link](https://example.com/c)\r\n三行目",
  "一行目  \n二行目 **太字** と [link](https://example.com/h)",
  "***強調と太字*** と **太字の中の *斜体* です** と続く文",
  "[![alt](https://example.com/i.png)](https://example.com/target) と続く文",
  "<https://example.com/abc> と <mailto:a@example.com> と続く",
  "**家族 👨‍👩‍👧‍👦 の絵文字を含む太字** と国旗 🇯🇵 の文",
];

/** Documents the server cuts inside, behind a filler of 0, 60 or 120 characters
 *  on the same line. */
export const LONG: readonly string[] = [
  "**要点**: [issue 1](https://github.com/a/b/issues/1) と [issue 2](https://github.com/a/b/issues/2) と `code one` と **bold two** を比べた結果、[PR 3](https://github.com/a/b/pull/3) が先、次に `pnpm test` と `mix test` を回す。参照 https://example.com/very/long/path?x=1&y=2 も見る。\n- 項目 [a](https://e.example/a) **b** `c`\n- 項目 [d](https://e.example/d) **e** `f`\n- 項目 [g](https://e.example/g) **h** `i`\n- 項目 [j](https://e.example/j) **k** `l`",
  "**要点** の説明を書く。次の表と手順は以下の通りで、読みやすさのために少し長めに書いておく。\n\n| 項目 | 値 | 備考 |\n|---|---|---|\n| a | 1 | メモ |\n| b | 2 | 別のメモ |\n| c | 3 | さらに別のメモ |\n\n```ts\nconst a = 1;\nconst b = [1, 2];\nconsole.log(a, b);\n```\n\n終わりの文章がここに続く。そして更に長く続けて、head の長さを超えるようにしておく。",
  "これは一つの長い段落で改行がありません。**重要な点** は [issue 514](https://github.com/sakuraiyuta/kaoiro/issues/514) にあり、`pnpm test` を回すと確認できます。さらに _斜体の語_ や ~~取り消し~~ もあり、https://example.com/a/b/c も参照しています。日本語は空白が無いので、切れる位置は文の途中になります。文章をさらに続けて、512 バイトを超えるまで書き続けます。まだ続けます。まだまだ続けます。もう少しだけ続けて十分な長さにします。",
].flatMap((text) => [0, 60, 120].map((k) => "あ".repeat(k) + " " + text));

/** The shapes that once drew a cut address: a link label as long as the head, a
 *  bold headline with an address in it, a headline with a link and an address,
 *  and a bare address, at the lengths around the 512-byte cut. Every eighth, since
 *  the cuts of one length are the cuts of the next shifted. */
export const CUT_ADDRESS: readonly string[] = (() => {
  const all: string[] = [];
  for (let k = 120; k <= 175; k++) all.push("[" + "あ".repeat(k) + "](" + GITHUB + ") 続き");
  for (let k = 100; k <= 160; k++) all.push("**" + "あ".repeat(k) + " " + GITHUB + " text**");
  for (let k = 90; k <= 160; k++) {
    all.push("**レビュー担当: [issue 518](" + GITHUB + ")" + "う".repeat(k) + "詳細 " + GITHUB + "**");
  }
  for (let k = 520; k <= 640; k += 7) all.push(GITHUB + "/" + "a".repeat(k));
  return all.filter((_, i) => i % 8 === 0);
})();

/** Reference definitions: the reference link and its definition are drawn
 *  together, so the cut that takes the definition must not leave a link to a
 *  half address. */
export const DEFINITIONS: readonly string[] = [
  "参照 [issue 514][i] を見る。\n\n[i]: https://github.com/sakuraiyuta/kaoiro/issues/514\n\n後の文",
  "[i]: https://github.com/sakuraiyuta/kaoiro/issues/514\n\n冒頭定義のあと [issue][i] を見る。",
  "参照 [issue 514] を見る。\n\n[issue 514]: https://github.com/sakuraiyuta/kaoiro/issues/514",
  "> 引用 [a][i]\n>\n> [i]: https://example.com/quoted/target\n\n後",
  "- 項目 [a][i]\n\n  [i]: https://example.com/in/list\n\n後",
  '参照 [issue][i] を見る。\n\n[i]: https://example.com/x "Issue title"\n\n後',
  '前置き\n\n[i]: https://example.com/x "title"\n\n後の文',
];

/** A label defined twice: the lexer emits no token for the second. */
export const DUPLICATE_DEFINITIONS: Record<string, string> = {
  top: "[i]: https://a.example/x\n[i]: https://b.example/y\n\n本文 [x][i] 後の文章がここに続く",
  middle:
    "前置き [x][i] の文\n\n[i]: https://a.example/x\n[i]: https://b.example/y\n\n本文 **強調** と [リンク](https://c.example/z) 後",
  three: "[i]: https://a.example/x\n[i]: https://b.example/y\n[i]: https://c.example/z\n\n本文 [x][i] 後",
  caseFolded: "[I]: https://a.example/x\n[i]: https://b.example/y\n\n本文",
  quote: "> [i]: https://a.example/x\n> [i]: https://b.example/y\n\n本文 [x][i] 後",
  list: "- 項目\n\n  [i]: https://a.example/x\n\n  [i]: https://b.example/y\n\n- 次の項目 **太字** 後",
  last: "本文 [x][i]\n\n[i]: https://a.example/x\n\n[i]: https://b.example/y",
  onlyDefinitions: "[i]: https://a.example/x\n[j]: https://b.example/y\n",
  afterParagraph: "本文の段落\n[i]: https://a.example/x\n[i]: https://b.example/y\n\n後",
  nestedAtEnd: "- item text\n\n  [i]: https://a.example/x\n\n- other\n\n  [i]: https://b.example/y",
  sameText: "[i]: a\n[i]: a",
};

/** Heads whose cut leaves a reading that depends on what comes after the cut:
 *  a reference whose definition follows, a footnote-style definition, a table
 *  without leading pipes. None can draw an address. */
export const RESIDUAL: Record<string, string> = {
  referenceLink: "参照 [issue 514][i] を見る。\n\n[i]: https://github.com/sakuraiyuta/kaoiro/issues/514",
  footnote: "脚注つきの文[^1] が続く。\n\n[^1]: 脚注の本文",
  pipelessTable: "a | b\n--|--\nc | d\n\n後の文",
};

// ---- a seeded random corpus ----

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "あいう", "設計を確認", "server", "runner", "テスト通過", "2 件", "待機中", "x_y", "a.b",
  "日本語の長い文章", "OK", "arr[0]", "2 * 3", "snake_case", "50%", "~5分",
];
const INLINE: readonly ((w: string) => string)[] = [
  (w) => w,
  (w) => `**${w}**`,
  (w) => `*${w}*`,
  (w) => `_${w}_`,
  (w) => `~~${w}~~`,
  (w) => `\`${w}\``,
  (w) => `[${w}](https://example.com/${w.length}/x)`,
  (w) => `**[${w}](https://example.com/n)**`,
  (w) => `[**${w}**](https://example.com/m)`,
  (w) => `![${w}](https://example.com/i.png)`,
  (w) => `https://example.com/p/${w.length}?a=1&b=2`,
  (w) => `<https://example.com/${w.length}>`,
  (w) => `AT&amp;T ${w} &copy;`,
  (w) => `\\*${w}\\*`,
  (w) => `${w} 👨‍👩‍👧‍👦 é 🇯🇵`,
  (w) => `<b>${w}</b>`,
];
const LEAD = ["", "", "- ", "- ", "1. ", "> ", "## ", "* "];

function randomDocument(next: () => number): string {
  const lines: string[] = [];
  const n = 2 + Math.floor(next() * 8);
  for (let i = 0; i < n; i++) {
    const kind = next();
    if (kind < 0.07) {
      lines.push("");
    } else if (kind < 0.12) {
      lines.push("```ts", "const a = [1, 2];", "// `x` **y**", "```");
    } else if (kind < 0.17) {
      lines.push("| h1 | h2 | h3 |", "|---|---|---|", "| a | **b** | [c](https://e.example/c) |", "| d | e | f |");
    } else {
      const parts: string[] = [];
      const m = 1 + Math.floor(next() * 5);
      for (let j = 0; j < m; j++) {
        const word = WORDS[Math.floor(next() * WORDS.length)]!;
        parts.push(INLINE[Math.floor(next() * INLINE.length)]!(word));
      }
      const lead = LEAD[Math.floor(next() * LEAD.length)]!;
      lines.push(lead + parts.join(next() < 0.5 ? " " : next() < 0.5 ? "と" : "x "));
    }
  }
  return lines.join("\n");
}

/** `count` random documents from one seed; the same seed gives the same ones. */
export function randomDocuments(seed: number, count: number): string[] {
  const next = rng(seed);
  return Array.from({ length: count }, () => randomDocument(next));
}

// ---- random strings over the tokens of markdown ----

const TOKENS = [
  "*", "**", "_", "__", "~", "~~", "`", "``", "[", "]", "(", ")", "<", ">", "!", "\\", "&",
  "&amp", "www.", "http://a.co/x", "https://b.co/y?q=1", "a", "b", "あ", " ", "  ", "\n",
  "\n\n", "- ", "1. ", "> ", "| ", "|---|", "# ", "```", "~~~", "\t", "[i]: ", "[i]", "x@y.co",
  "<b>", '"t"', "](", "](http://c.co/z)", "[x]", "<http://d.co/w>", "![", "***",
];

/** `count` strings glued from the tokens of markdown, with no regard for
 *  meaning: they reach the places where two constructs meet, which documents
 *  written to read well never do. */
export function tokenDocuments(seed: number, count: number): string[] {
  const next = rng(seed);
  return Array.from({ length: count }, () => {
    const length = 8 + Math.floor(next() * 32);
    let doc = "";
    for (let i = 0; i < length; i++) doc += TOKENS[Math.floor(next() * TOKENS.length)]!;
    return doc;
  });
}
