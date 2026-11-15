import { beforeEach, afterEach, vi } from "vitest";
import { handleLexRequest, type LexMessage, type LexRequest } from "../src/lib/markdownTokens";
import { disposeMarkdownWorker } from "../src/lib/markdownWorker";

export const lexerOutcomes: LexMessage[] = [];
class TestLexerWorker {
  onmessage: ((event: { data: LexMessage }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror = null;
  closed = false;
  postMessage(request: LexRequest) {
    void Promise.resolve().then(() => {
      if (this.closed) return;
      try {
        handleLexRequest(request, (message) => {
          lexerOutcomes.push(message);
          this.onmessage?.({ data: structuredClone(message) });
        });
      } catch { this.onerror?.(); }
    });
  }
  terminate() { this.closed = true; }
}

beforeEach(() => {
  if (typeof window === "undefined") return;
  disposeMarkdownWorker();
  lexerOutcomes.length = 0;
  vi.stubGlobal("Worker", TestLexerWorker);
});
afterEach(() => { disposeMarkdownWorker(); vi.unstubAllGlobals(); });
