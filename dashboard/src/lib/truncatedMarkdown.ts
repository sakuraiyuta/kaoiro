// The head of a status line that the server cut at 512 bytes (issue 514) is
// markdown that may stop inside a construct. Drawn as it is, it shows raw
// syntax (`**`, `[x](`) or, worse, a link whose address was cut short and
// still opens, because `https://gith` is a valid URL. This module returns the
// longest start of the head that draws only what the full text draws.
//
// The block structure and the extent of every closed inline construct come from
// the lexer that also draws the text (`untrustedMarked`), so the two cannot
// disagree about them. Hand rules cover only what the lexer leaves as text: a
// delimiter that has not been closed yet, a bracket, a trailing escape. An
// address (anything the lexer gives an `href`) that reaches the end of the head
// is always cut, never unwrapped, because the rest of it is unknown.
//
// Carriage returns become line feeds and tabs become four spaces first. The
// lexer expands the tabs of a list item's text, and the line map below needs the
// head to say what the text says.
//
// Known residuals, none of which draws a link the full text does not draw:
// - A delimiter the full text shows literally can be hidden here (the unwrap
//   and the second step delete pending delimiters).
// - A head that starts with a table, a bare URL, a link destination, an
//   autolink, an unclosed code span, an empty fence or only reference
//   definitions trims to nothing.
// - A cut bold headline is drawn plain.
// - What a prefix cannot see: a reference link whose definition comes after the
//   head, a footnote-style definition and a table without leading pipes draw
//   their brackets as text.
//
// Every regex here runs on a head of at most 512 bytes but also inside a loop
// that runs once per removed line, so none may backtrack: each character of a
// line has one way to match.

import { Lexer } from "marked";
import { untrustedMarked } from "./untrustedMarkdown";

/** The token fields this module reads. */
interface Tok {
  type: string;
  raw: string;
  text: string;
  tokens?: Tok[];
  items?: Tok[];
  href?: string;
  codeBlockStyle?: string;
}

/** Where a pending construct starts. `len` is the length of the delimiter run
 *  that goes when the construct is unwrapped (0: cut only); `pair` is a closing
 *  bracket that goes with it. */
interface Pending {
  pos: number;
  len: number;
  code?: boolean;
  bracket?: boolean;
  pair?: { pos: number; len: number };
}

// A line that is only a block marker still being typed, or only a rule: it is a
// list item, a quote, a fence, a rule or a setext underline once the line ends.
const PARTIAL_MARKER =
  /^(?=.)[ \t]*(?:>[ \t]*)*(?:(?:\d{1,9}[.)]?|[-*+]|#{1,6}|`{1,2}|~{1,2}|\|)[ \t]*)?$/;
const PARTIAL_RULE = /^ {0,3}(?:(?:-[ \t]*)+|(?:_[ \t]*)+|(?:\*[ \t]*)+|=+[ \t]*)$/;
// A table delimiter row still being typed: dashes with a pipe, nothing else.
const PARTIAL_DELIM_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t:-]*)?$/;

const LEFT = Lexer.rules.inline.breaks;
const DEFINITION = Lexer.rules.block.gfm.def;
const ALNUM = /[\p{L}\p{N}]/u;

function lexBlocks(text: string): Tok[] {
  return untrustedMarked.lexer(text) as unknown as Tok[];
}

function sumRaw(tokens: readonly Tok[]): number {
  let n = 0;
  for (const token of tokens) n += token.raw.length;
  return n;
}

/** The head up to its previous line start: the answer when the lexer's tokens
 *  cannot be laid over the head. */
function previousLine(head: string): string {
  const i = head.trimEnd().lastIndexOf("\n");
  return i === -1 ? "" : head.slice(0, i + 1);
}

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

/** Whether a delimiter run may open an emphasis or strike, from the lexer's own
 *  left-delimiter patterns: both need a non-space character right after the
 *  run. The lexer then also looks at the character before the run, which this
 *  test ignores, so it can say "may open" where the lexer would not, never the
 *  reverse. `_` inside a word is the one case the lexer excludes on the
 *  character before, applied here when that character is in the same text
 *  token (the lexer forgets it after any other token). */
function mayOpen(run: string, rest: string, prev: string | undefined, inToken: boolean): boolean {
  if (run[0] === "~") return LEFT.delLDelim.exec(rest) !== null;
  const m = LEFT.emStrongLDelim.exec(rest);
  if (m === null || !(m[1] || m[2] || m[3] || m[4])) return false;
  if (run[0] === "_" && m[4] && inToken && prev !== undefined && ALNUM.test(prev)) return false;
  return true;
}

/** Every trailing line that is only a partial marker or rule, dropped at once. */
function dropMarkerLines(head: string): string {
  let h = head;
  for (;;) {
    const t = h.endsWith("\n") ? h.slice(0, -1) : h;
    const at = t.lastIndexOf("\n") + 1;
    const last = t.slice(at);
    if (last !== "" && (PARTIAL_MARKER.test(last) || PARTIAL_RULE.test(last))) h = t.slice(0, at);
    else return h;
  }
}

/** Every address the lexer finds in `text`: links, images, autolinks and
 *  definitions, at any depth. */
function addressesOf(text: string): Set<string> {
  const found = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const token = node as { href?: unknown };
    if (typeof token.href === "string") found.add(token.href);
    Object.values(token).forEach(visit);
  };
  visit(lexBlocks(text));
  return found;
}

/** The head without its last line when that line is a whole reference
 *  definition, else the head. The lexer emits no token for a definition whose
 *  label was defined before and appends the newline after it to the token
 *  before, so a duplicate at the end leaves the tokens short of the head. It
 *  draws nothing, so dropping it loses nothing. */
function dropDefinitionLine(head: string): string {
  const t = head.trimEnd();
  const at = t.lastIndexOf("\n") + 1;
  const line = t.slice(at).replace(/^[ >]*(?:(?:[-*+]|\d{1,9}[.)]) )?/, "");
  const m = DEFINITION.exec(line);
  return m !== null && m[0].trimEnd() === line ? head.slice(0, at) : head;
}

/** The deepest last block: descend the last list item and the quote content. */
function deepestLast(block: Tok): Tok {
  let deep = block;
  for (;;) {
    let kids: Tok[] | null = null;
    if (deep.type === "list") kids = deep.items?.at(-1)?.tokens ?? [];
    else if (deep.type === "blockquote") kids = deep.tokens ?? [];
    if (kids === null) return deep;
    const content = kids.filter((t) => t.type !== "space");
    const last = content.at(-1);
    if (last === undefined) return { type: "empty", raw: "", text: "" };
    deep = last;
  }
}

function step(head: string, onFallback: (() => void) | undefined): string {
  if (head.trim() === "") return head;
  const dropped = dropMarkerLines(head);
  if (dropped !== head) return dropped;

  const fallback = (h: string): string => {
    const shorter = dropDefinitionLine(h);
    if (shorter !== h) return shorter;
    onFallback?.();
    return previousLine(h);
  };

  const blocks = lexBlocks(head);
  let li = blocks.length - 1;
  while (li >= 0 && blocks[li].type === "space") li--;
  if (li < 0) return head;
  // Everything below counts lines from the end of the head, so only the end
  // has to line up: the last block must be the tail of the head.
  if (!head.trimEnd().endsWith(blocks[li].raw.trimEnd())) return fallback(head);
  const deep = deepestLast(blocks[li]);
  // A blank line ends a paragraph, so what is unfinished in it stays literal in
  // the full text too. Inside a fence it is part of the code.
  const inFence = deep.type === "code" && deep.codeBlockStyle !== "indented";
  if (/\n[ \t]*\n[ \t]*$/.test(head) && !inFence) return head;

  const lines = head.split("\n");
  const lineAt: number[] = [];
  for (let o = 0, i = 0; i < lines.length; o += lines[i].length + 1, i++) lineAt.push(o);
  let lastNz = lines.length - 1;
  while (lastNz >= 0 && lines[lastNz].trim() === "") lastNz--;
  if (lastNz < 0) return head;
  const lineCount = (raw: string): number => raw.replace(/\n+$/, "").split("\n").length;
  const startOfLines = (n: number): number => lineAt[Math.max(0, lastNz - n + 1)];

  // A definition on the last line: its address is not final until the line
  // ends, and a cut one would turn a reference into a link to the wrong place.
  if (typeof deep.href === "string" && !/\s$/.test(head)) {
    return head.slice(0, startOfLines(lineCount(deep.raw)));
  }
  if (deep.type === "empty") return head.slice(0, lineAt[lastNz]);
  if (deep.type === "table") return head.slice(0, startOfLines(lineCount(deep.raw)));
  if (inFence) {
    const n = lineCount(deep.raw);
    const first = lines[lastNz - n + 1] ?? "";
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(first.replace(/^[ >]*(?:[-*+] |\d+[.)] )?/, ""));
    const lastLine = lines[lastNz];
    const closed =
      n >= 2 &&
      opener !== null &&
      new RegExp(
        `^[ >]*(?:[-*+] |\\d+[.)] )? {0,3}${opener[1][0]}{${opener[1].length},}\\s*$`,
      ).test(lastLine);
    if (closed) return head;
    if (n - 1 <= 0 || deep.text.trim() === "") return head.slice(0, startOfLines(n));
    const bareRun = /^[ >]*(?:[-*+] |\d+[.)] )? {0,3}[`~]+$/.test(lastLine);
    return bareRun && n >= 2 ? head.slice(0, lineAt[lastNz]) : head;
  }
  if (!(deep.type === "paragraph" || deep.type === "heading" || deep.type === "text")) return head;
  if (!Array.isArray(deep.tokens)) return head;

  // The leaf: its text, and a map from a text index back to the head.
  const s = deep.text;
  const textLines = s.split("\n");
  const k = textLines.length;
  if (k > lastNz + 1) return fallback(head);
  const firstLine = lastNz - k + 1;
  const textLineStart: number[] = [];
  const headBase: number[] = [];
  for (let p = 0, so = 0; p < k; so += textLines[p].length + 1, p++) {
    const r = lines[firstLine + p].trimEnd();
    const t = textLines[p].trimEnd();
    const idx = t === "" ? r.length : r.lastIndexOf(t);
    if (idx < 0) return fallback(head);
    textLineStart.push(so);
    headBase.push(lineAt[firstLine + p] + idx);
  }
  const toHead = (textIndex: number): number => {
    let p = k - 1;
    while (p > 0 && textLineStart[p] > textIndex) p--;
    return headBase[p] + (textIndex - textLineStart[p]);
  };
  const leafLineStart = lineAt[firstLine];
  const contentStart = toHead(0);

  if (s.trim() === "") return head.slice(0, leafLineStart);

  const endsOpen = !/\s$/.test(head);

  // The delimiter run that touches the end means something else once the next
  // character arrives, so it is not lexed.
  let tailAt = s.length;
  if (endsOpen) {
    const m = /[*_~`]+$/.exec(s);
    if (m !== null) {
      let backslashes = 0;
      while (m.index - 1 - backslashes >= 0 && s[m.index - 1 - backslashes] === "\\") backslashes++;
      tailAt = backslashes % 2 === 1 ? m.index + 1 : m.index;
      if (tailAt >= s.length) tailAt = s.length;
    }
  }
  const lexedText = s.slice(0, tailAt);
  const inline = Lexer.lexInline(lexedText, untrustedMarked.defaults) as unknown as Tok[];
  if (sumRaw(inline) !== lexedText.length) return fallback(head);

  // Which characters of the lexed text the lexer left as plain text.
  const isText = new Uint8Array(lexedText.length);
  const markText = (tokens: readonly Tok[], base: number): boolean => {
    let at = base;
    for (const t of tokens) {
      if (t.type === "text") {
        for (let i = 0; i < t.raw.length; i++) isText[at + i] = 1;
      } else if (t.type === "strong" || t.type === "em" || t.type === "del") {
        const off = t.raw.indexOf(t.text);
        const inner = t.tokens ?? [];
        if (off < 0 || sumRaw(inner) !== t.text.length) return false;
        if (!markText(inner, at + off)) return false;
      }
      at += t.raw.length;
    }
    return true;
  };
  if (!markText(inline, 0)) return fallback(head);

  // Mandatory cuts carry an address and are never unwrapped; the rest are
  // pending constructs.
  let mandatory = Infinity;
  const pending: Pending[] = [];
  const addMandatory = (pos: number): void => {
    mandatory = Math.min(mandatory, pos);
  };
  const closingBracket = (open: number): number => {
    let depth = 0;
    for (let i = open; i < lexedText.length; i++) {
      if (!isText[i]) continue;
      if (lexedText[i] === "[") depth++;
      else if (lexedText[i] === "]" && --depth === 0) return i;
    }
    return -1;
  };

  const scanText = (raw: string, start: number): void => {
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      const abs = start + i;
      if (c === "*" || c === "_" || c === "~") {
        let n = 1;
        while (i + n < raw.length && raw[i + n] === c) n++;
        const prev = abs > 0 ? s[abs - 1] : undefined;
        if (mayOpen(c.repeat(n), s.slice(abs), prev, i > 0)) pending.push({ pos: abs, len: n });
        i += n - 1;
      } else if (c === "`") {
        let n = 1;
        while (i + n < raw.length && raw[i + n] === c) n++;
        pending.push({ pos: abs, len: n, code: true });
        i += n - 1;
      } else if (c === "[") {
        const from = abs > 0 && lexedText[abs - 1] === "!" ? abs - 1 : abs;
        const close = closingBracket(abs);
        if (close === -1) {
          pending.push({ pos: from, len: abs - from + 1, bracket: true });
        } else {
          const after = s[close + 1];
          if (after === undefined && endsOpen) {
            pending.push({
              pos: from,
              len: abs - from + 1,
              bracket: true,
              pair: { pos: close, len: 1 },
            });
          } else if (after === "(" && s.indexOf(")", close + 2) === -1) {
            // The destination has begun and no link token exists yet.
            addMandatory(close);
            pending.push({ pos: from, len: abs - from + 1, bracket: true });
          }
        }
      } else if (c === "<") {
        const next = s[abs + 1];
        if (next === undefined ? endsOpen : !isSpace(next)) pending.push({ pos: abs, len: 0 });
      }
    }
  };

  const walk = (tokens: readonly Tok[], base: number): void => {
    let at = base;
    for (const t of tokens) {
      const start = at;
      const end = at + t.raw.length;
      at = end;
      if (t.type === "text") {
        scanText(t.raw, start);
      } else if (t.type === "strong" || t.type === "em" || t.type === "del") {
        walk(t.tokens ?? [], start + t.raw.indexOf(t.text));
      } else if (typeof t.href === "string") {
        // Whatever carries an address and touches the end may still grow.
        if (t.raw[0] === "[" || t.raw[0] === "!") {
          if (endsOpen && /[()]/.test(t.href) && !/\s/.test(s.slice(end))) addMandatory(start);
        } else if (t.raw[0] !== "<") {
          if (endsOpen && !/[\s<]/.test(s.slice(end))) addMandatory(start);
        }
      }
    }
  };
  walk(inline, 0);
  if (tailAt < s.length) pending.push({ pos: tailAt, len: s.length - tailAt });
  if (endsOpen) {
    if (s.endsWith("\\") || s.endsWith("!")) pending.push({ pos: s.length - 1, len: 1 });
    const entity = /&#?\w*$/.exec(s);
    if (entity !== null) pending.push({ pos: entity.index, len: s.length - entity.index });
  }
  // A fence opener is text until its newline arrives.
  if (endsOpen && /^ {0,3}(?:`{3,}|~{3,})/.test(textLines[k - 1])) {
    pending.push({ pos: textLineStart[k - 1], len: 0 });
  }
  // A lone line that starts like a definition becomes one when its title or its
  // address arrives; until then it would draw a link the full text does not.
  if (!head.endsWith("\n") && k === 1 && /^ {0,3}\[[^\]]+\]:/.test(s)) {
    pending.push({ pos: 0, len: 0 });
  }
  // Lines of pipes at the end may be the first rows of a table the head cuts
  // short.
  let q = k;
  while (q > 0 && /^[ \t]*\|/.test(textLines[q - 1])) q--;
  if (q < k) {
    pending.push({ pos: textLineStart[q], len: 0 });
  } else if (
    k >= 2 &&
    PARTIAL_DELIM_ROW.test(textLines[k - 1]) &&
    textLines[k - 1].includes("|") &&
    textLines[k - 2].includes("|")
  ) {
    pending.push({ pos: textLineStart[k - 2], len: 0 });
  }

  pending.sort((a, b) => a.pos - b.pos);
  const cut = Math.min(mandatory, pending[0]?.pos ?? Infinity);
  if (cut === Infinity) return head;
  const cutAt = toHead(cut);
  if (head.slice(contentStart, cutAt).trim() !== "") return head.slice(0, cutAt);
  if (head.slice(0, leafLineStart).trim() !== "") return head.slice(0, leafLineStart);

  // Nothing precedes the first unfinished construct: keep its text, drop its
  // markup. What follows an unmatched backtick may be code in the full text,
  // where nothing is a link, so the text ends there.
  const codeAt = pending.find((p) => p.code)?.pos ?? Infinity;
  const cutOnly = pending.find((p) => p.len === 0 && p.pos <= codeAt)?.pos;
  const limit = Math.min(
    mandatory === Infinity ? Infinity : toHead(mandatory),
    head.length,
    cutOnly === undefined ? Infinity : toHead(cutOnly),
    codeAt === Infinity ? Infinity : toHead(codeAt),
  );
  let kept = head.slice(0, limit);
  const drop = new Set<number>();
  const mark = (pos: number, len: number): void => {
    const h = toHead(pos);
    for (let i = h; i < h + len && i < kept.length; i++) drop.add(i);
  };
  let deletedBracket = false;
  for (const p of pending) {
    if (p.pos >= codeAt || p.len === 0 || toHead(p.pos) >= limit) continue;
    mark(p.pos, p.len);
    if (p.pair !== undefined) mark(p.pair.pos, p.pair.len);
    if (p.bracket) deletedBracket = true;
  }
  if (drop.size > 0) {
    kept = kept.split("").filter((_, i) => !drop.has(i)).join("");
    // Deleting a delimiter can join the text on both sides of it into an
    // address, and the text after a deleted bracket may be a link label in the
    // full text, where an address is not a link of its own. Either way the
    // head would draw a link the full text does not.
    const allowed = deletedBracket ? new Set<string>() : addressesOf(head.slice(0, limit));
    for (const address of addressesOf(kept)) {
      if (!allowed.has(address)) return head.slice(0, leafLineStart);
    }
  }
  if (kept.length > leafLineStart && kept.slice(contentStart).trim() === "") {
    kept = kept.slice(0, leafLineStart);
  }
  return kept;
}

/** Whether the head draws nothing: only reference definitions and blank lines. */
function onlyDefinitions(head: string): boolean {
  const blocks = lexBlocks(head);
  return blocks.every((t) => t.type === "space" || t.type === "def");
}

/** The start of `head` that draws only what the full text draws (see the top of
 *  this file). Call it only for a head the server cut; a complete line is drawn
 *  as it is. The result can be empty. `onFallback` is told each time the
 *  lexer's tokens could not be laid over the head and the head was cut back to
 *  its previous line instead; that is expected never to happen. */
export function trimIncompleteMarkdown(head: string, onFallback?: () => void): string {
  let current = head.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  try {
    // A step returns its input or a strictly shorter string, so this ends
    // within `current.length` steps.
    for (let left = current.length; left >= 0; left--) {
      const next = step(current, onFallback);
      if (next === current) return current.trim() !== "" && onlyDefinitions(current) ? "" : current;
      current = next;
    }
  } catch {
    // Falls through: a head that is not trimmed could draw a link to a half address.
  }
  onFallback?.();
  return "";
}
