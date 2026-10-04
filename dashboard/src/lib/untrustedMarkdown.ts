// Renders markdown written by someone else - an agent's status line, an
// operator's ToDo - under the fixed policy the operator chose (issue 482):
// raw HTML is shown literally, links keep only http(s), images are shown as
// links and never loaded, nothing is time-bounded beyond the guards below.
//
// This is deliberately NOT `markdown.ts`. That module renders chat replies and
// still passes sanitized raw HTML, loads images and allows other link schemes;
// changing chat rendering is outside this policy. This one is the stricter
// sibling, with its own `Marked` and DOMPurify instances so that neither the
// global `marked` options nor the default DOMPurify hooks are touched. Issue
// 483 renders operator-authored text through the same module and component, so
// a change to the policy needs both owners.
//
// Two layers: the marked renderer decides what becomes HTML, and DOMPurify
// strips whatever a bug in the first would let through.
//
// Two profiles share the policy (issue 514). The full profile renders blocks,
// links and tables for the change log and the detail view. The inline profile
// is for the agent card, where the text sits inside a button: it flattens
// every block into phrasing content and draws a link as underlined text that
// cannot be pressed, because a button may not contain an interactive element.

import createDOMPurify from "dompurify";
import { Marked, type Token, type Tokens } from "marked";

/** Deeper than this (blockquote or list nesting) renders as plain text. A
 *  deep nest makes the lexer overflow the stack, and below that DOMPurify slow
 *  on the resulting tree (measured: ">" x 1000 took 459 ms to sanitize). */
export const MAX_NESTING_DEPTH = 32;

export type UntrustedRender =
  | { kind: "html"; html: string }
  /** Parsing or sanitizing failed or was refused; show the source as text. */
  | { kind: "plain" };

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The href when it is an absolute http(s) URL, else null. Relative and
 *  protocol-relative references do not parse, and `javascript:`, `data:`,
 *  `mailto:` and the rest are not http(s). marked has already decoded entity
 *  encoded schemes by the time the renderer sees an href. */
function httpUrl(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const marked = new Marked({
  async: false,
  breaks: true,
  gfm: true,
  renderer: {
    // Raw HTML is shown as the text the author wrote.
    html(token) {
      return escapeHtml(token.text);
    },
    // An image is never loaded: it becomes a link to its URL, labelled with
    // its alt text, or just the alt text when the URL is not http(s).
    image(token) {
      const url = httpUrl(token.href);
      const label = escapeHtml(token.text || token.href);
      return url === null ? escapeHtml(token.text) : `<a href="${escapeHtml(url)}">${label}</a>`;
    },
    // A task list tick is an <input>, which layer two forbids, so it would
    // vanish and "done" would read the same as "todo". Show it as text instead.
    checkbox(token) {
      return token.checked ? "[x] " : "[ ] ";
    },
    // Only an http(s) link stays a link; any other keeps just its label.
    link(token) {
      const label = this.parser.parseInline(token.tokens);
      const url = httpUrl(token.href);
      return url === null ? label : `<a href="${escapeHtml(url)}">${label}</a>`;
    },
  },
});

/** The class layer one gives a link it draws as text on the card. */
const INLINE_LINK_CLASS = "md-link";

/** The tags the inline profile may emit; nothing else survives layer two. */
const INLINE_TAGS = ["strong", "em", "code", "del", "br", "span"];

/** Source line breaks in a raw HTML or code block become breaks the card
 *  counts, so no bare newline is left beside a `<br>` to draw a second one. */
function breaks(escaped: string): string {
  return escaped.replace(/\r?\n/g, "<br>");
}

/** A newline inside inline text (an image's alt text, a trailing hard break
 *  marked leaves in a text token) is a space. */
function oneLine(escaped: string): string {
  return escaped.replace(/\s*\r?\n\s*/g, " ");
}

const inlineMarked = new Marked({
  async: false,
  breaks: true,
  gfm: true,
  renderer: {
    html(token) {
      return breaks(escapeHtml(token.text));
    },
    // Never an element and never a URL: the alt text alone, on one line.
    image(token) {
      return oneLine(escapeHtml(token.text));
    },
    // A block of text in a tight list item has tokens and ends the line; an
    // inline text token is just the text.
    text(token) {
      if ("tokens" in token && token.tokens) return `${this.parser.parseInline(token.tokens)}<br>`;
      return oneLine("escaped" in token && token.escaped ? token.text : escapeHtml(token.text));
    },
    checkbox(token) {
      return token.checked ? "[x] " : "[ ] ";
    },
    // Drawn like a link only when the dialog would make it one (http or
    // https); any other link keeps just its label there too.
    link(token) {
      const label = this.parser.parseInline(token.tokens);
      return httpUrl(token.href) === null ? label : `<span class="${INLINE_LINK_CLASS}">${label}</span>`;
    },
    heading(token) {
      return `<strong>${this.parser.parseInline(token.tokens)}</strong><br>`;
    },
    paragraph(token) {
      return `${this.parser.parseInline(token.tokens)}<br>`;
    },
    list(token: Tokens.List) {
      const first = Number(token.start || 1);
      return token.items
        .map((item, index) => {
          const marker = token.ordered ? `${first + index}. ` : "・";
          // Every block of an item ends its own line; an empty item still does.
          return `${marker}${item.tokens.length === 0 ? "<br>" : this.parser.parse(item.tokens)}`;
        })
        .join("");
    },
    blockquote(token) {
      return this.parser.parse(token.tokens);
    },
    code(token) {
      return `<code>${breaks(escapeHtml(token.text))}</code><br>`;
    },
    table(token: Tokens.Table) {
      const row = (cells: Tokens.TableCell[]) =>
        `${cells.map((cell) => this.parser.parseInline(cell.tokens)).join(" | ")}<br>`;
      return row(token.header) + token.rows.map(row).join("");
    },
    hr() {
      return "";
    },
  },
});

/** Layer one of the inline profile on its own: markdown to the HTML the card
 *  would show before sanitizing. Exported so that what marked emits can be
 *  asserted without layer two hiding a regression. It holds no newline: every
 *  renderer that could carry one turns it into a break or a space. */
export function inlineMarkdownToHtml(text: string): string {
  return finishInline(inlineMarked.parser(inlineMarked.lexer(text)));
}

// A run of breaks (a blank line inside a code block, an empty heading) is one
// break, and the text neither starts nor ends with one.
function finishInline(html: string): string {
  return html.replace(/(?:<br>)+/g, "<br>").replace(/^<br>|<br>$/g, "");
}

let purifier: ReturnType<typeof createDOMPurify> | null = null;

// Created on first use rather than at import, so a module that imports this one
// without a DOM (a server-side build, a test without jsdom) is not broken by it.
// The dedicated instance carries its own hook: a hook on the default instance
// would leak into the chat renderer.
function getPurifier(): ReturnType<typeof createDOMPurify> {
  if (purifier === null) {
    const instance = createDOMPurify(window);
    instance.addHook("afterSanitizeAttributes", (node) => {
      if (node.nodeName === "A" && node.hasAttribute("href")) {
        node.setAttribute("rel", "noopener noreferrer nofollow");
        node.setAttribute("target", "_blank");
      }
    });
    purifier = instance;
  }
  return purifier;
}

/** Layer two on its own: strips whatever HTML reaches it, whether or not the
 *  marked layer already did. Exported so it can be pinned without layer one. */
export function sanitizeUntrustedHtml(html: string): string {
  return getPurifier().sanitize(html, {
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
    // DOMPurify tests every attribute outside its URI-safe list against the
    // pattern above, not only href, so these two would lose their meaning
    // (a list's first number, a table column's alignment). Neither is a URL.
    ADD_URI_SAFE_ATTR: ["align", "start"],
    FORBID_TAGS: ["img", "style", "svg", "math", "iframe", "form", "input"],
    FORBID_ATTR: ["style"],
  });
}

let inlinePurifier: ReturnType<typeof createDOMPurify> | null = null;

// A separate instance, so the full profile keeps what it allows (a code
// block's language class) and its link hook. DOMPurify has no value-level
// allow-list, so the one class the inline profile emits is kept by a hook:
// `class` survives only on a span and only as exactly `md-link`.
function getInlinePurifier(): ReturnType<typeof createDOMPurify> {
  if (inlinePurifier === null) {
    const instance = createDOMPurify(window);
    instance.addHook("uponSanitizeAttribute", (node, data) => {
      if (data.attrName === "class" && !(node.nodeName === "SPAN" && data.attrValue === INLINE_LINK_CLASS)) {
        data.keepAttr = false;
      }
    });
    inlinePurifier = instance;
  }
  return inlinePurifier;
}

/** Layer two of the inline profile on its own: six tags, the one class on a
 *  span, and no `data-*` or `aria-*` attribute. */
export function sanitizeUntrustedInlineHtml(html: string): string {
  return getInlinePurifier().sanitize(html, {
    ALLOWED_TAGS: INLINE_TAGS,
    ALLOWED_ATTR: ["class"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}

/** Blockquote and list nesting along the deepest path of a token tree. */
function nestingDepth(tokens: readonly Token[]): number {
  let deepest = 0;
  for (const token of tokens) {
    const children: Token[] = [];
    if ("tokens" in token && Array.isArray(token.tokens)) children.push(...token.tokens);
    if (token.type === "list" && "items" in token && Array.isArray(token.items)) {
      for (const item of token.items) children.push(item as Token);
    }
    const own = token.type === "blockquote" || token.type === "list" ? 1 : 0;
    deepest = Math.max(deepest, own + nestingDepth(children));
  }
  return deepest;
}

/** Markdown to sanitized HTML under the policy above, or `plain` when it cannot
 *  be done safely and quickly: the parser threw, or the nesting is too deep.
 *  The time is bounded per click, not per input: for 16 KB the slowest shape
 *  measured (jsdom, load about 2.7) was "*a _b" x 3276 at 739 ms, and a deep
 *  "> - " nest costs about 544 ms of lexing before it falls back to plain. */
export function renderUntrustedMarkdown(text: string): UntrustedRender {
  try {
    const tokens = marked.lexer(text);
    if (nestingDepth(tokens) > MAX_NESTING_DEPTH) return { kind: "plain" };
    return { kind: "html", html: sanitizeUntrustedHtml(marked.parser(tokens)) };
  } catch {
    return { kind: "plain" };
  }
}

/** The inline profile for a one-line or few-line summary (the agent card, a
 *  collapsed entry of the change log): phrasing content only, links drawn as
 *  text, or `plain` under the same conditions as `renderUntrustedMarkdown`, and
 *  also when the source draws nothing. */
export function renderUntrustedInline(text: string): UntrustedRender {
  try {
    const tokens = inlineMarked.lexer(text);
    if (nestingDepth(tokens) > MAX_NESTING_DEPTH) return { kind: "plain" };
    const html = sanitizeUntrustedInlineHtml(finishInline(inlineMarked.parser(tokens)));
    // A source that draws no text (a rule, an empty heading) would leave an
    // empty summary; show the text the author wrote instead.
    return html.replace(/<[^>]*>/g, "").trim() === "" ? { kind: "plain" } : { kind: "html", html };
  } catch {
    return { kind: "plain" };
  }
}

/** How many lines the inline output draws before any clamp: the breaks of the
 *  rendered HTML plus one, or the source lines of the plain fallback. */
export function inlineLineCount(rendered: UntrustedRender, text: string): number {
  if (rendered.kind === "plain") return text.split("\n").length;
  return (rendered.html.match(/<br>/g)?.length ?? 0) + 1;
}
