import type { LexMessage, LexRequest, LexResult } from "./markdownTokens";

export type LexerPort = Pick<Worker,
  "onmessage" | "onerror" | "onmessageerror" | "postMessage" | "terminate"
>;
type Job = LexRequest & { owner: object; accept: (r: LexResult) => void };
const APPLY_WINDOW_MS = 50;

/** One reusable worker, one active request, latest pending request per owner. */
export class MarkdownWorker {
  private worker: LexerPort | null = null;
  private active: Job | null = null;
  private pending = new Map<object, Job>();
  private ready = new Map<object, { job: Job; result: LexResult }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private applyTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;
  private disabled = false;

  constructor(private create: () => LexerPort = () => new Worker(
    new URL("./markdown.worker.ts", import.meta.url), { type: "module" },
  )) {}

  /** `accept` must not throw: one batch applies several owners' results, and a
   *  throw leaves the rest of that batch until the next drain. */
  request(owner: object, text: string, accept: Job["accept"]): () => void {
    this.remove(owner);
    const job = { id: ++this.sequence, owner, text, accept };
    this.pending.set(owner, job);
    this.drain();
    return () => {
      if (this.active === job || this.pending.get(owner) === job
        || this.ready.get(owner)?.job === job) {
        this.remove(owner);
        this.drain();
      }
    };
  }

  private remove(owner: object): void {
    this.pending.delete(owner);
    this.ready.delete(owner);
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

  /** Dispatch the next job, then apply settled results: at once when the
   *  worker is idle, otherwise together after a window, because applying
   *  them one by one costs one rendered frame per worker round trip. */
  private drain(): void {
    this.dispatch();
    if (this.ready.size === 0) return;
    if (!this.active) this.apply();
    else this.applyTimer ??= setTimeout(() => this.apply(), APPLY_WINDOW_MS);
  }

  private apply(): void {
    if (this.applyTimer !== null) clearTimeout(this.applyTimer);
    this.applyTimer = null;
    for (const [owner, { job, result }] of this.ready) {
      this.ready.delete(owner);
      job.accept(result);
    }
  }

  private dispatch(): void {
    if (this.active) return;
    for (const [owner, job] of this.pending) {
      this.pending.delete(owner);
      if (this.disabled) {
        this.ready.set(owner, { job, result: { kind: "plain", reason: "unavailable" } });
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
    if (job) this.ready.set(job.owner, { job, result });
    this.drain();
  }

  private fail(): void {
    this.disabled = true;
    this.finish({ kind: "plain", reason: "unavailable" });
  }

  dispose(): void {
    this.disabled = true;
    this.pending.clear();
    this.ready.clear();
    if (this.applyTimer !== null) clearTimeout(this.applyTimer);
    this.applyTimer = null;
    this.clear(true);
  }
}

export let markdownWorker = new MarkdownWorker();

export function disposeMarkdownWorker(): void {
  markdownWorker.dispose();
  markdownWorker = new MarkdownWorker();
}
