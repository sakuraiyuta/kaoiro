// Renders untrusted markdown (agent replies and the operator's echoed
// instructions) to sanitized HTML for {@html} (#30). Both sources are
// untrusted, so this is the single XSS chokepoint: marked turns markdown
// into HTML, then DOMPurify strips scripts, event handlers, and
// javascript: URLs before the string is ever inserted as HTML.

import { marked } from "marked";
import DOMPurify from "dompurify";

const MARKDOWN_SANITIZER_POLICY = {
  // Untrusted markdown must not be able to cover controls in the surrounding
  // application with positioned raw HTML. CSS is not needed for chat prose,
  // so reject both inline style attributes and raw <style> blocks entirely.
  FORBID_ATTR: ["style"],
  FORBID_TAGS: ["style"],
};

const MERMAID_SANITIZER_POLICY = {
  // Mermaid's strict renderer emits SVG styling in a <style> block. This is a
  // deliberately separate policy from raw markdown: only generated diagram
  // SVG reaches this path, and DOMPurify still removes scripts/handlers.
  USE_PROFILES: { svg: true, svgFilters: true, html: true },
  ADD_TAGS: ["style"],
};

/** Markdown -> sanitized HTML. Never returns script/handler markup. */
export function renderMarkdown(text: string): string {
  // async:false selects marked's synchronous overload (returns string,
  // not Promise); breaks turns single newlines into <br> for chat text.
  const html = marked.parse(text, { async: false, breaks: true });
  return DOMPurify.sanitize(html, MARKDOWN_SANITIZER_POLICY);
}

/** Sanitizes Mermaid's generated SVG under its narrowly-scoped style policy. */
export function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(svg, MERMAID_SANITIZER_POLICY);
}

// Mermaid (#42) is lazy-loaded so non-diagram replies never pull the large
// library, and run with securityLevel:"strict" so the diagram source — which
// originates from the untrusted agent reply — is sanitized by mermaid itself.
let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
let mermaidSeq = 0;

function loadMermaid(): Promise<typeof import("mermaid").default> {
  if (mermaidReady === null) {
    mermaidReady = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "dark",
        // Render node/edge labels as SVG <text>, not HTML <foreignObject>
        // (#42). The defence-in-depth DOMPurify pass below strips a
        // foreignObject's inner HTML entirely (verified), which left every
        // node blank; <text> labels survive sanitization and pick up their
        // colour from mermaid's <style> block, which also survives.
        htmlLabels: false,
      });
      return mermaid;
    });
  }
  return mermaidReady;
}

/**
 * Renders any ```mermaid fences already present in `container` (the sanitized
 * markdown emits them as <pre><code class="language-mermaid">) into SVG
 * diagrams in place. Idempotent: already-rendered blocks carry no such code
 * element, so re-running after each transcript update only renders new ones.
 * A diagram that fails to parse is left as its source code block.
 */
export async function renderMermaidIn(container: HTMLElement): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>(
    "code.language-mermaid",
  );
  if (blocks.length === 0) return;
  const mermaid = await loadMermaid();
  for (const code of blocks) {
    const pre = code.closest("pre");
    if (pre === null) continue;
    const id = `kaoiro-mmd-${mermaidSeq++}`;
    try {
      const { svg } = await mermaid.render(id, code.textContent ?? "");
      const figure = document.createElement("div");
      figure.className = "mermaid-rendered";
      // Defence-in-depth: mermaid sanitizes internally under securityLevel
      // "strict", but the diagram is untrusted-derived, so route the SVG
      // through the same DOMPurify chokepoint as renderMarkdown before it
      // reaches the DOM. The svg/svgFilters profiles keep mermaid's shapes
      // and its <text> labels (htmlLabels:false above means no
      // <foreignObject> HTML labels are emitted); the html profile is kept
      // defensively for any stray inline HTML, while scripts/handlers are
      // still stripped.
      figure.innerHTML = sanitizeMermaidSvg(svg);
      pre.replaceWith(figure);
    } catch {
      // Mermaid leaves an orphan node behind on a parse error; it is the
      // render id prefixed with "d" (mermaid 11.x). Remove both forms
      // defensively in case that private convention shifts.
      document.getElementById(`d${id}`)?.remove();
      document.getElementById(id)?.remove();
    }
  }
}
