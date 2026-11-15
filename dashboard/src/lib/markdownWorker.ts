import type { LexMessage, LexRequest, LexResult } from "./markdownTokens";

export type LexerPort = Pick<Worker,
  "onmessage" | "onerror" | "onmessageerror" | "postMessage" | "terminate"
>;
type Job = LexRequest & { owner: object; accept: (r: LexResult) => void };

/** One reusable worker, one active request, latest pending request per owner. */
export class MarkdownWorker {
  private worker: LexerPort | null = null;
  private active: Job | null = null;
  private pending = new Map<object, Job>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;
  private disabled = false;

  constructor(private create: () => LexerPort = () => new Worker(
    new URL("./markdown.worker.ts", import.meta.url), { type: "module" },
  )) {}

  request(owner: object, text: string, accept: Job["accept"]): () => void {
    this.remove(owner);
    const job = { id: ++this.sequence, owner, text, accept };
    this.pending.set(owner, job);
    this.drain();
    return () => {
      if (this.active === job || this.pending.get(owner) === job) {
        this.remove(owner);
        this.drain();
      }
    };
  }

  private remove(owner: object): void {
    this.pending.delete(owner);
    if (this.active?.owner === owner) {
      this.clear(true);
    }
  }

  private clear(terminate: boolean): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.active = null;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
      if (terminate) {
        this.worker.terminate();
        this.worker = null;
      }
    }
  }

  private drain(): void {
    if (this.active) return;
    for (const [owner, job] of this.pending) {
      this.pending.delete(owner);
      if (this.disabled) {
        job.accept({ kind: "plain", reason: "unavailable" });
        continue;
      }
      this.active = job;
      try {
        const worker = this.worker ??= this.create();
        const current = () => this.active === job && this.worker === worker;
        worker.onmessage = ({ data }: MessageEvent<LexMessage>) => {
          if (!current() || data.id !== job.id) return;
          if (data.kind === "started") {
            if (this.timer === null) {
              this.timer = setTimeout(() => {
                if (current()) this.finish({ kind: "plain", reason: "timeout" });
              }, 1000);
            }
          } else {
            this.finish(data);
          }
        };
        worker.onerror = worker.onmessageerror = () => {
          if (current()) this.fail();
        };
        worker.postMessage({ id: job.id, text: job.text });
      } catch {
        this.fail();
      }
      return;
    }
  }

  private finish(result: LexResult): void {
    const job = this.active;
    this.clear(result.kind === "plain");
    job?.accept(result);
    this.drain();
  }

  private fail(): void {
    this.disabled = true;
    this.finish({ kind: "plain", reason: "unavailable" });
  }

  dispose(): void {
    this.disabled = true;
    this.pending.clear();
    this.clear(true);
  }
}

export let markdownWorker = new MarkdownWorker();

export function disposeMarkdownWorker(): void {
  markdownWorker.dispose();
  markdownWorker = new MarkdownWorker();
}
