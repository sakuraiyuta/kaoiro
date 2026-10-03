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

import createDOMPurify from "dompurify";
import { Marked, type Token } from "marked";

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
    // Only an http(s) link stays a link; any other keeps just its label.
    link(token) {
      const label = this.parser.parseInline(token.tokens);
      const url = httpUrl(token.href);
      return url === null ? label : `<a href="${escapeHtml(url)}">${label}</a>`;
    },
  },
});

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
    FORBID_TAGS: ["img", "style", "svg", "math", "iframe", "form", "input"],
    FORBID_ATTR: ["style"],
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
 *  be done safely and quickly: the parser threw, or the nesting is too deep. */
export function renderUntrustedMarkdown(text: string): UntrustedRender {
  try {
    const tokens = marked.lexer(text);
    if (nestingDepth(tokens) > MAX_NESTING_DEPTH) return { kind: "plain" };
    return { kind: "html", html: sanitizeUntrustedHtml(marked.parser(tokens)) };
  } catch {
    return { kind: "plain" };
  }
}
