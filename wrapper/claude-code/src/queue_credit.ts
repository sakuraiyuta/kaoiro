// The wrapper's single queue credit (credit-v1). The server keeps at most one
// outstanding credit per wrapper and a new `credit` supersedes the previous
// one, so root and early input share this one record of who holds it.
//
// `request` must be called in the same synchronous step as the caller's final
// readiness check: `QueueLease.credit` pushes before its first await, so the
// call order here is the order the server sees.

import type { QueueControlResult, QueueLease } from "@kaoiro/wrapper-core";

export type CreditKind = "root" | "early";

interface Holder {
  kind: CreditKind;
  token: string;
  revision: string | null;
}

export type CreditRequest =
  | { kind: "root"; token: string }
  | { kind: "early"; token: string; mechanism: "fold" | "steer" };

export type CreditOutcome =
  | { kind: "granted" }
  /** Another request or a clear replaced this one while it was in flight. */
  | { kind: "superseded" }
  | { kind: "refused"; error: Extract<QueueControlResult<"credit">, { ok: false }>["error"] };

export class CreditSlot {
  #holder: Holder | null = null;

  /** The token of the outstanding or requested credit of `kind`, if any. */
  token(kind: CreditKind): string | null {
    return this.#holder?.kind === kind ? this.#holder.token : null;
  }

  async request(lease: QueueLease, request: CreditRequest): Promise<CreditOutcome> {
    const holder: Holder = { kind: request.kind, token: request.token, revision: null };
    this.#holder = holder;
    const result = await (request.kind === "root"
      ? lease.credit("root", request.token)
      : lease.credit("early", request.token, request.mechanism));
    const current = this.#holder === holder;
    if (!result.ok) {
      if (current) this.#holder = null;
      return current ? { kind: "refused", error: result.error } : { kind: "superseded" };
    }
    if (!current) {
      void lease.withdraw(result.reply.credit_revision);
      return { kind: "superseded" };
    }
    holder.revision = result.reply.credit_revision;
    return { kind: "granted" };
  }

  /** An offer under the credit of `kind` and `token` arrived and used it. */
  consume(kind: CreditKind, token: string): boolean {
    if (this.#holder?.kind !== kind || this.#holder.token !== token) return false;
    this.#holder = null;
    return true;
  }

  /** Gives up the credit of `kind`; a granted one is withdrawn, an in-flight
   *  one when its reply arrives. Returns whether there was one. */
  clear(kind: CreditKind, lease: QueueLease | null): boolean {
    const holder = this.#holder;
    if (holder?.kind !== kind) return false;
    this.#holder = null;
    if (holder.revision !== null) void lease?.withdraw(holder.revision);
    return true;
  }

  /** A join dropped any credit the server held. */
  reset(): void {
    this.#holder = null;
  }
}
