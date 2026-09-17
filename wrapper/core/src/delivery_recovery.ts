import { randomUUID } from "node:crypto";
import type { Envelope, InterAgentDeliveryStatus } from "@kaoiro/protocol";

export interface DeliveryResyncRequest {
  request_id: string;
  cutoff: number;
  missing_ranges: [number, number][];
}

export interface DeliveryResyncReply {
  delivery: InterAgentDeliveryStatus;
  skipped_ranges: [number, number][];
}

/** Receipt is separate from dispatch: a queued SDK input must never be
 * mistaken for a transport loss just because its turn has not started. */
export class DeliveryRecovery {
  #resolved = 0;
  #issued = 0;
  #received = new Set<number>();
  #supported = false;
  #connected = false;
  #disposed = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending: DeliveryResyncRequest | undefined;
  #inFlight = false;
  #quarantined = new Map<number, Envelope>();

  constructor(private readonly callbacks: {
    request: (request: DeliveryResyncRequest) => Promise<DeliveryResyncReply | null>;
    resolved: (reply: DeliveryResyncReply) => void;
    resendAck: (seq: number) => void;
    unavailable: () => void;
  }) {}

  receive(envelope: Envelope): boolean {
    const seq = (envelope as Envelope & { delivery_seq?: number }).delivery_seq;
    if (!Number.isSafeInteger(seq) || seq! <= 0) return true;
    if (this.#supported && (seq! <= this.#resolved || this.#received.has(seq!))) return false;
    // A requested retirement is irrevocable locally until the server resolves
    // it. Late frames cannot race the loss report into an SDK turn. Timeout
    // keeps the same request for retry rather than reopening admission.
    if (this.#pending?.missing_ranges.some(([first, last]) => seq! >= first && seq! <= last)) {
      this.#quarantined.set(seq!, envelope);
      return false;
    }
    this.#received.add(seq!);
    this.#schedule();
    return true;
  }

  confirm(seq: number): void {
    this.#resolved = Math.max(this.#resolved, seq);
    for (const received of this.#received) {
      if (received <= this.#resolved) this.#received.delete(received);
    }
    this.#schedule();
  }

  observe(status: InterAgentDeliveryStatus | null): void {
    if (status === null) return;
    this.#issued = Math.max(this.#issued, status.issued_seq);
    this.confirm(status.acked_seq);
  }

  join(supported: boolean, status: InterAgentDeliveryStatus | null): void {
    this.#supported = supported;
    this.#connected = true;
    this.observe(status);
    if (!supported) {
      this.callbacks.unavailable();
      return;
    }
    if (status !== null && this.#resolved > status.acked_seq) {
      this.callbacks.resendAck(this.#resolved);
    }
    // The join snapshot predates the new channel subscription. Later issued
    // sequences need the grace timer because independent senders can reorder
    // their envelope and status broadcasts.
    if (this.#pending !== undefined) void this.#request();
    else if (status !== null) this.#start(status.issued_seq);
  }

  disconnected(): void {
    this.#connected = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  dispose(): void {
    this.disconnected();
    this.#disposed = true;
  }

  #missing(cutoff: number): [number, number][] {
    const ranges: [number, number][] = [];
    let count = 0;
    for (let seq = this.#resolved + 1; seq <= cutoff && count < 256; seq++) {
      if (this.#received.has(seq)) continue;
      const previous = ranges.at(-1);
      if (previous !== undefined && previous[1] === seq - 1) previous[1] = seq;
      else ranges.push([seq, seq]);
      count++;
    }
    return ranges;
  }

  #schedule(): void {
    if (this.#disposed || !this.#connected || !this.#supported) return;
    if (this.#pending === undefined && this.#missing(this.#issued).length === 0) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      return;
    }
    if (this.#timer !== undefined || this.#inFlight) return;
    const cutoff = this.#issued;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#pending !== undefined) void this.#request();
      else this.#start(cutoff);
      this.#schedule();
    }, 30_000);
    this.#timer.unref?.();
  }

  #start(cutoff: number): void {
    const ranges = this.#missing(cutoff);
    if (ranges.length === 0 || this.#disposed) return;
    this.#pending = { request_id: randomUUID(), cutoff, missing_ranges: ranges };
    void this.#request();
  }

  async #request(): Promise<void> {
    if (this.#pending === undefined || this.#inFlight || !this.#connected || this.#disposed) return;
    const pending = this.#pending;
    this.#inFlight = true;
    try {
      const reply = await this.callbacks.request(pending);
      if (this.#disposed || reply === null) return;
      for (const [first, last] of reply.skipped_ranges) {
        for (let seq = first; seq <= last; seq++) {
          this.#received.add(seq);
          this.#quarantined.delete(seq);
        }
      }
      this.#pending = undefined;
      this.observe(reply.delivery);
      this.callbacks.resolved(reply);
    } finally {
      this.#inFlight = false;
      this.#schedule();
    }
  }
}
