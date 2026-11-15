import { marked, type Token, type TokensList } from "marked";

export const LEXER_OPTIONS = { async: false, breaks: true, gfm: true } as const;
export const MAX_NESTING_DEPTH = 32;
export type LexResult =
  | { kind: "tokens"; tokens: TokensList }
  | { kind: "plain"; reason: "depth" | "lexer" | "timeout" | "unavailable" };
export type LexRequest = { id: number; text: string };
export type LexMessage = { id: number } & (
  | { kind: "started" }
  | LexResult
);

/** DOM-free worker operation; token arrays retain their reference-link map. */
export function lexMarkdown(text: string): LexResult {
  try {
    const tokens = marked.lexer(text, LEXER_OPTIONS);
    return nestingDepth(tokens) > MAX_NESTING_DEPTH
      ? { kind: "plain", reason: "depth" }
      : { kind: "tokens", tokens };
  } catch {
    return { kind: "plain", reason: "lexer" };
  }
}

/** The same message handler is used by the worker and test-only transport. */
export function handleLexRequest(
  request: LexRequest, send: (message: LexMessage) => void,
): void {
  send({ id: request.id, kind: "started" });
  send({ id: request.id, ...lexMarkdown(request.text) });
}

/** Blockquote and list nesting along the deepest path of a token tree. The
 *  chat renderer (markdown.ts) measures with it too, where one paragraph can
 *  hold more inline tokens than an argument list can spread, so each array is
 *  walked in place. */
export function nestingDepth(tokens: readonly Token[]): number {
  let deepest = 0;
  for (const token of tokens) {
    let below = 0;
    if ("tokens" in token && Array.isArray(token.tokens)) below = nestingDepth(token.tokens);
    if (token.type === "list" && "items" in token && Array.isArray(token.items)) {
      below = Math.max(below, nestingDepth(token.items as Token[]));
    }
    const own = token.type === "blockquote" || token.type === "list" ? 1 : 0;
    deepest = Math.max(deepest, own + below);
  }
  return deepest;
}

