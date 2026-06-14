// Renders untrusted markdown (agent replies and the operator's echoed
// instructions) to sanitized HTML for {@html} (#30). Both sources are
// untrusted, so this is the single XSS chokepoint: marked turns markdown
// into HTML, then DOMPurify strips scripts, event handlers, and
// javascript: URLs before the string is ever inserted as HTML.

import { marked } from "marked";
import DOMPurify from "dompurify";

/** Markdown -> sanitized HTML. Never returns script/handler markup. */
export function renderMarkdown(text: string): string {
  // async:false selects marked's synchronous overload (returns string,
  // not Promise); breaks turns single newlines into <br> for chat text.
  const html = marked.parse(text, { async: false, breaks: true });
  return DOMPurify.sanitize(html);
}
