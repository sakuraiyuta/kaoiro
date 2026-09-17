import type { AppServerNotification } from "./app_server_rpc.js";

export class AppServerTurnStream implements AsyncIterableIterator<AppServerNotification> {
  #queue: AppServerNotification[] = [];
  #ended = false;
  #error: Error | undefined;
  #wake: (() => void) | undefined;
  #reading = false;
  #abandoned = false;

  push(event: AppServerNotification): void {
    if (this.#ended || this.#abandoned) return;
    this.#queue.push(event);
    this.#wake?.();
  }

  finish(): void {
    this.#ended = true;
    this.#wake?.();
  }

  fail(error: Error): void {
    if (this.#ended) return;
    this.#error = error;
    this.finish();
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<AppServerNotification> { return this; }

  async next(): Promise<IteratorResult<AppServerNotification>> {
    if (this.#reading) throw new Error("A turn stream has only one consumer");
    this.#reading = true;
    try {
      while (true) {
        // Completion and EOF must not hide events already delivered by the reader.
        const event = this.#queue.shift();
        if (event) return { value: event, done: false };
        if (this.#error) throw this.#error;
        if (this.#ended) return { value: undefined, done: true };
        await new Promise<void>((resolve) => { this.#wake = resolve; });
        this.#wake = undefined;
      }
    } finally {
      this.#reading = false;
    }
  }

  async return(): Promise<IteratorResult<AppServerNotification>> {
    this.#abandoned = true;
    this.#queue = [];
    this.#error = undefined;
    this.finish();
    return { value: undefined, done: true };
  }
}
