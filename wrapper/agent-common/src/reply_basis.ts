import { randomBytes } from "node:crypto";
import type { Envelope, InterAgentMessagePayload } from "./types.js";
import type { ToolResult } from "./tooling.js";

export interface ReplyOrigin {
  readonly token: string;
  readonly signal?: AbortSignal;
}
export interface ReplyAuthorization {
  in_reply_to: number;
  reply_ticket: string;
  expires_in_ms: number;
}
interface Snapshot {
  controller: AbortController;
  basis: ReadonlyMap<string, number>;
  signal?: AbortSignal;
}
interface Ticket {
  token: string;
  cid: string;
  peer: string;
  basis: number;
  state: "provisional" | "unused" | "spent" | "superseded";
  expires: number;
}
export interface ReplyAttempt {
  origin: ReplyOrigin;
  cid: string;
  peer: string;
  basis: number;
  ticket?: Ticket;
}
const key = (cid: string, peer: string): string => JSON.stringify([cid, peer]);
export function ordinaryPeerInput(envelope: Envelope): boolean {
  const p = envelope.payload as Partial<InterAgentMessagePayload>;
  return envelope.type === "inter_agent_message" && envelope.agent_id !== "server" &&
    p.notice_type === undefined && typeof p.conversation_id === "string" &&
    Number.isSafeInteger(p.turn_number) && (p.turn_number ?? 0) > 0;
}

/** Session-owned input provenance. Queue receipt never calls observe(). */
export class ReplyBasis {
  readonly #delivered = new Map<string, number>();
  readonly #snapshots = new Map<string, Snapshot>();
  readonly #tickets = new Map<string, Ticket>();
  readonly #clock: () => number;
  constructor(clock: () => number = () => performance.now()) { this.#clock = clock; }

  observe(envelopes: readonly Envelope[]): void {
    for (const envelope of envelopes) {
      if (!ordinaryPeerInput(envelope)) continue;
      const p = envelope.payload as unknown as InterAgentMessagePayload;
      const k = key(p.conversation_id, envelope.agent_id);
      this.#delivered.set(k, Math.max(this.#delivered.get(k) ?? 0, p.turn_number));
    }
  }
  begin(token: string, envelopes: readonly Envelope[], signal?: AbortSignal): void {
    if (this.#snapshots.has(token)) throw Error("SDK turn token reused");
    this.observe(envelopes);
    const controller = new AbortController();
    this.#snapshots.set(token, { controller, basis: new Map(this.#delivered), signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
  }
  retire(token: string): void {
    this.#snapshots.get(token)?.controller.abort();
    this.#snapshots.delete(token);
    for (const [value, ticket] of this.#tickets) if (ticket.token === token) this.#tickets.delete(value);
  }
  forget(cid: string): void {
    for (const k of this.#delivered.keys()) if ((JSON.parse(k) as string[])[0] === cid) this.#delivered.delete(k);
    for (const [value, ticket] of this.#tickets) if (ticket.cid === cid) this.#tickets.delete(value);
  }
  reset(): void { for (const token of this.#snapshots.keys()) this.retire(token); this.#delivered.clear(); this.#tickets.clear(); }
  live(origin: ReplyOrigin | undefined): string | undefined {
    if (!origin) return "unbound_tool_call";
    const snapshot = this.#snapshots.get(origin.token);
    return !snapshot || origin.signal?.aborted || snapshot.signal?.aborted ? "stale_tool_call" : undefined;
  }
  capture(origin: ReplyOrigin | undefined, cid: string, peer: string,
    explicit?: number, value?: string): ReplyAttempt | string {
    const invalidOrigin = this.live(origin);
    if (invalidOrigin) return invalidOrigin;
    const snapshot = this.#snapshots.get(origin!.token)!;
    const bound = { token: origin!.token, signal: AbortSignal.any([snapshot.signal!, ...(origin!.signal ? [origin!.signal] : [])]) };
    if (explicit === undefined && value === undefined) {
      return { origin: bound, cid, peer, basis: this.#snapshots.get(bound.token)!.basis.get(key(cid, peer)) ?? 0 };
    }
    if (explicit === undefined || value === undefined) return "reply_ticket_required";
    const ticket = this.#tickets.get(value);
    if (!ticket || ticket.token !== bound.token || ticket.cid !== cid || ticket.peer !== peer || ticket.basis !== explicit) return "invalid_reply_ticket";
    if (ticket.state === "spent") return "spent_reply_ticket";
    if (ticket.state !== "unused") return "invalid_reply_ticket";
    if (this.#clock() >= ticket.expires) return "expired_reply_ticket";
    ticket.state = "spent";
    return { origin: bound, cid, peer, basis: explicit, ticket };
  }
  beforeSend(attempt: ReplyAttempt): string | undefined {
    return this.live(attempt.origin) ?? (attempt.ticket && this.#clock() >= attempt.ticket.expires ? "expired_reply_ticket" : undefined);
  }
  prepare(origin: ReplyOrigin, cid: string, peer: string, basis: number, renewal = false): {
    authorization: ReplyAuthorization; valid: () => boolean; activate: () => boolean; discard: () => void;
  } | undefined {
    if (this.live(origin)) return undefined;
    const active = [...this.#tickets.values()].filter(t => t.token === origin.token);
    if (active.length >= 256) return undefined;
    const newer = () => [...this.#tickets.values()].some(t => t.token === origin.token && t.cid === cid && t.peer === peer && t.state === "unused" && t.basis > basis);
    if (renewal && newer()) return undefined;
    let value: string;
    do { value = randomBytes(32).toString("base64url"); } while (this.#tickets.has(value));
    const ticket: Ticket = { token: origin.token, cid, peer, basis, state: "provisional", expires: 0 };
    this.#tickets.set(value, ticket);
    const discard = () => { if (ticket.state === "provisional") this.#tickets.delete(value); };
    const valid = () => ticket.state === "provisional" && this.live(origin) === undefined && this.#tickets.has(value) && (!renewal || !newer());
    return {
      valid,
      authorization: { in_reply_to: basis, reply_ticket: value, expires_in_ms: 300_000 }, discard,
      activate: () => {
        if (!valid()) { discard(); return false; }
        for (const prior of this.#tickets.values()) {
          if (prior !== ticket && prior.token === origin.token && prior.cid === cid && prior.peer === peer && prior.state === "unused") prior.state = "superseded";
        }
        ticket.expires = this.#clock() + 300_000; ticket.state = "unused";
        return true;
      },
    };
  }
}

interface Handoff {
  live: () => boolean;
  commit: () => void;
  rollback: () => void;
}
const handoffs = new WeakMap<ToolResult, Handoff>();
export function bindToolResultHandoff(result: ToolResult, handoff: Handoff): ToolResult {
  handoffs.set(result, handoff); return result;
}
/** Called at each real adapter's write/return boundary, never at handler completion. */
export function handoffToolResult(result: ToolResult, write: () => void): boolean {
  const pending = handoffs.get(result);
  handoffs.delete(result);
  if (pending && !pending.live()) { pending.rollback(); return false; }
  try { write(); } catch (error) { pending?.rollback(); throw error; }
  pending?.commit();
  return true;
}
export function discardToolResult(result: ToolResult): void {
  const pending = handoffs.get(result); handoffs.delete(result); pending?.rollback();
}
