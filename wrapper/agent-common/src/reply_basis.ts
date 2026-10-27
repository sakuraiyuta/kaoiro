import { randomBytes } from "node:crypto";
import type { Envelope, InterAgentMessagePayload } from "./types.js";
import type { ToolResult } from "./tooling.js";

export interface ReplyOrigin {
  readonly token: string;
  readonly signal?: AbortSignal;
}
declare const detachedBasisBrand: unique symbol;
/** Opaque default map: it carries neither a source signal nor reply tickets. */
export interface DetachedReplyBasis { readonly [detachedBasisBrand]: true }
export type ReplyProofValidator = () => Promise<string | undefined>;
export interface ReplyAuthorization {
  in_reply_to: number;
  reply_ticket: string;
  expires_in_ms: number;
}
interface Snapshot {
  controller: AbortController;
  basis: ReadonlyMap<string, number>;
  signal?: AbortSignal;
  proofRequired?: boolean;
  validateProof?: ReplyProofValidator;
  validateState?: () => boolean;
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
interface IssuedTicketHistory {
  readonly tuples: Set<string>;
  saturated: boolean;
}
const COPY_BOTH_FIELDS = "Copy both fields";
export const REPLY_TICKET_REQUIRED_GUIDANCE = `${COPY_BOTH_FIELDS} from the original reply_authorization; an unspent, unexpired ticket can be retried.`;
// A resumed Claude session keeps the tool description it recorded, which may
// predate these two properties, so the result names them.
export const REPLY_AUTHORIZATION_USAGE_GUIDANCE = `${COPY_BOTH_FIELDS} (in_reply_to and reply_ticket) from this reply_authorization into your next send_to_agent call to reply in this turn, even if the tool description you were shown does not list them.`;
export const FOLLOWUP_AUTHORIZATION_GUIDANCE = "Your previous send was accepted; for a new follow-up to the same peer and conversation in this turn, copy in_reply_to and reply_ticket from this reply_authorization, and do not resend the accepted body.";
export type ReplyTicketGuidance =
  | "copy_matching_authorization"
  | "wait_for_matching_authorization"
  | "wait_for_fresh_authorization"
  | "plain_reply"
  | "wait_for_confirmed_input"
  | "wait_for_matching_basis"
  | "wait_for_history";

const key = (cid: string, peer: string): string => JSON.stringify([cid, peer]);
export function ordinaryPeerInput(envelope: Envelope): boolean {
  const p = envelope.payload as Partial<InterAgentMessagePayload>;
  return envelope.type === "inter_agent_message" && envelope.agent_id !== "server" &&
    p.notice_type === undefined && typeof p.conversation_id === "string" &&
    Number.isSafeInteger(p.turn_number) && (p.turn_number ?? 0) > 0;
}

/** Session-owned input provenance. Queue receipt never calls observe(). */
export class ReplyBasis {
  readonly #detached = new WeakMap<DetachedReplyBasis, { epoch: number; basis: ReadonlyMap<string, number> }>();
  #epoch = 0;
  readonly #delivered = new Map<string, number>();
  readonly #completed = new Map<string, number>();
  readonly #confirmedByToken = new Map<string, Map<string, number>>();
  readonly #pendingInputByToken = new Map<string, readonly Envelope[]>();
  readonly #snapshots = new Map<string, Snapshot>();
  readonly #tickets = new Map<string, Ticket>();
  readonly #issuedHistory = new Map<string, IssuedTicketHistory>();
  readonly #clock: () => number;
  constructor(clock: () => number = () => performance.now()) { this.#clock = clock; }

  #merge(target: Map<string, number>, envelopes: readonly Envelope[]): void {
    for (const envelope of envelopes) {
      if (!ordinaryPeerInput(envelope)) continue;
      const p = envelope.payload as unknown as InterAgentMessagePayload;
      const k = key(p.conversation_id, envelope.agent_id);
      target.set(k, Math.max(target.get(k) ?? 0, p.turn_number));
    }
  }
  observe(envelopes: readonly Envelope[], token?: string): void {
    if (token !== undefined && !this.#snapshots.has(token) && !this.#confirmedByToken.has(token)) return;
    this.#merge(this.#delivered, envelopes);
    if (token !== undefined) {
      const confirmed = this.#confirmedByToken.get(token);
      if (confirmed) this.#merge(confirmed, envelopes);
    }
  }
  observeFolded(envelopes: readonly Envelope[]): void {
    // A fold is usable through its ticket, but is not default input for a later root.
    void envelopes;
  }
  creditFolded(envelopes: readonly Envelope[], token: string): void {
    this.#merge(this.#delivered, envelopes);
    this.#merge(this.#completed, envelopes);
    const confirmed = this.#confirmedByToken.get(token);
    if (confirmed && this.#snapshots.has(token)) this.#merge(confirmed, envelopes);
  }
  begin(token: string, envelopes: readonly Envelope[], signal?: AbortSignal, deferInputConfirmation = false): void {
    if (this.#snapshots.has(token)) throw Error("SDK turn token reused");
    this.#confirmedByToken.set(token, new Map());
    if (deferInputConfirmation) this.#pendingInputByToken.set(token, envelopes);
    else this.observe(envelopes, token);
    const basis = new Map(this.#delivered);
    if (deferInputConfirmation) this.#merge(basis, envelopes);
    const controller = new AbortController();
    this.#snapshots.set(token, { controller, basis, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
  }
  /** An SDK-owned turn can use only input confirmed before earlier turns ended. */
  beginFromCompleted(token: string, signal?: AbortSignal): void {
    if (this.#snapshots.has(token)) throw Error("SDK turn token reused");
    this.#confirmedByToken.set(token, new Map());
    const controller = new AbortController();
    this.#snapshots.set(token, { controller, basis: new Map(this.#completed), signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
  }
  #detach(basis: ReadonlyMap<string, number>): DetachedReplyBasis {
    const detached = Object.freeze({}) as DetachedReplyBasis;
    this.#detached.set(detached, { epoch: this.#epoch, basis: new Map(basis) });
    return detached;
  }
  exportConfirmed(origin: ReplyOrigin): DetachedReplyBasis | undefined {
    if (this.live(origin) || this.#pendingInputByToken.has(origin.token)) return undefined;
    return this.#detach(this.#snapshots.get(origin.token)!.basis);
  }
  exportCompleted(): DetachedReplyBasis { return this.#detach(this.#completed); }
  sameDetached(left: DetachedReplyBasis, right: DetachedReplyBasis): boolean {
    const a = this.#detached.get(left), b = this.#detached.get(right);
    return !!a && !!b && a.epoch === this.#epoch && b.epoch === this.#epoch &&
      a.basis.size === b.basis.size && [...a.basis].every(([k, n]) => b.basis.get(k) === n);
  }
  /** True while a detached snapshot belongs to the live epoch. Only the epoch is checked: beginDetached still rejects a reused turn token. */
  isCurrentDetached(detached: DetachedReplyBasis): boolean { return this.#detached.get(detached)?.epoch === this.#epoch; }
  beginDetached(token: string, detached: DetachedReplyBasis, validateProof: ReplyProofValidator, signal?: AbortSignal, validateState?: () => boolean): void {
    const data = this.#detached.get(detached);
    if (!data || data.epoch !== this.#epoch) throw Error("invalid detached reply basis");
    if (this.#snapshots.has(token)) throw Error("SDK turn token reused");
    const controller = new AbortController();
    this.#confirmedByToken.set(token, new Map());
    this.#snapshots.set(token, { basis: new Map(data.basis), controller,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      proofRequired: true, validateProof, ...(validateState ? { validateState } : {}) });
  }
  async validateBeforeSend(attempt: ReplyAttempt): Promise<string | undefined> {
    const invalid = this.beforeSend(attempt);
    if (invalid) return invalid;
    const snapshot = this.#snapshots.get(attempt.origin.token)!;
    if (!snapshot.proofRequired) return undefined;
    if (!snapshot.validateProof) return "missing_native_proof_validator";
    try { return await snapshot.validateProof() ?? this.beforeSend(attempt); }
    catch { return "native_proof_invalid"; }
  }
  confirmInput(token: string): void {
    const pending = this.#pendingInputByToken.get(token);
    if (!pending || !this.#snapshots.has(token)) return;
    this.#pendingInputByToken.delete(token);
    this.observe(pending, token);
  }
  retire(token: string): void {
    const confirmed = this.#confirmedByToken.get(token);
    if (confirmed && this.#snapshots.has(token)) {
      for (const [k, n] of confirmed) this.#completed.set(k, Math.max(this.#completed.get(k) ?? 0, n));
    }
    this.#confirmedByToken.delete(token);
    this.#pendingInputByToken.delete(token);
    this.#snapshots.get(token)?.controller.abort();
    this.#snapshots.delete(token);
    for (const [value, ticket] of this.#tickets) if (ticket.token === token) this.#tickets.delete(value);
    this.#issuedHistory.delete(token);
  }
  ticketCountForTurn(token: string): number {
    return [...this.#tickets.values()].filter(ticket => ticket.token === token).length;
  }
  forget(cid: string): void {
    for (const k of this.#delivered.keys()) if ((JSON.parse(k) as string[])[0] === cid) this.#delivered.delete(k);
    for (const k of this.#completed.keys()) if ((JSON.parse(k) as string[])[0] === cid) this.#completed.delete(k);
    for (const confirmed of this.#confirmedByToken.values()) for (const k of confirmed.keys()) if ((JSON.parse(k) as string[])[0] === cid) confirmed.delete(k);
    for (const [token, pending] of this.#pendingInputByToken) this.#pendingInputByToken.set(token, pending.filter(e => (e.payload as Partial<InterAgentMessagePayload>).conversation_id !== cid));
    for (const [value, ticket] of this.#tickets) if (ticket.cid === cid) this.#tickets.delete(value);
    // Keep issuance facts across forget(): deleting a live ticket must not make an issued tuple look never-issued.
  }
  reset(): void { this.#epoch++; for (const token of this.#snapshots.keys()) this.retire(token); this.#delivered.clear(); this.#completed.clear(); this.#confirmedByToken.clear(); this.#pendingInputByToken.clear(); this.#tickets.clear(); this.#issuedHistory.clear(); }
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
  replyTicketGuidance(origin: ReplyOrigin, cid: string, peer: string, supplied: number): ReplyTicketGuidance {
    const snapshot = this.#snapshots.get(origin.token)!;
    const tuple = key(cid, peer);
    const records = [...this.#tickets.values()].filter(ticket => ticket.token === origin.token && ticket.cid === cid && ticket.peer === peer);
    const now = this.#clock();
    const usable = records.filter(ticket => ticket.state === "unused" && now < ticket.expires);
    if (usable.some(ticket => ticket.basis === supplied)) return "copy_matching_authorization";
    if (usable.length > 0) return "wait_for_matching_authorization";

    const history = this.#issuedHistory.get(origin.token);
    if (history?.tuples.has(tuple) || records.some(ticket => ticket.state !== "provisional")) {
      return "wait_for_fresh_authorization";
    }
    if (history?.saturated) return "wait_for_history";

    const frozen = snapshot.basis.get(tuple) ?? 0;
    if (supplied === frozen) return frozen > 0 ? "plain_reply" : "wait_for_confirmed_input";
    return "wait_for_matching_basis";
  }

  hasMatchingAuthorization(origin: ReplyOrigin, cid: string, peer: string, basis: unknown): boolean {
    return this.live(origin) === undefined && typeof basis === "number" && Number.isSafeInteger(basis) && basis > 0 &&
      this.replyTicketGuidance(origin, cid, peer, basis) === "copy_matching_authorization";
  }

  needsFollowup(attempt: ReplyAttempt): boolean {
    const snapshot = this.#snapshots.get(attempt.origin.token);
    return !!attempt.ticket && !!snapshot && attempt.basis > (snapshot.basis.get(key(attempt.cid, attempt.peer)) ?? 0);
  }

  prepareFollowup(attempt: ReplyAttempt): ReturnType<ReplyBasis["prepare"]> {
    const ticket = attempt.ticket;
    if (this.live(attempt.origin) || !this.needsFollowup(attempt) || !ticket || ticket.state !== "spent" ||
      ![...this.#tickets.values()].includes(ticket) || ticket.token !== attempt.origin.token ||
      ticket.cid !== attempt.cid || ticket.peer !== attempt.peer || ticket.basis !== attempt.basis) return undefined;
    return this.prepare(attempt.origin, attempt.cid, attempt.peer, attempt.basis, true);
  }

  #recordIssued(ticket: Ticket): void {
    let history = this.#issuedHistory.get(ticket.token);
    if (!history) {
      history = { tuples: new Set(), saturated: false };
      this.#issuedHistory.set(ticket.token, history);
    }
    const tuple = key(ticket.cid, ticket.peer);
    if (history.tuples.has(tuple) || history.saturated) return;
    if (history.tuples.size === 256) {
      history.saturated = true;
      return;
    }
    history.tuples.add(tuple);
  }
  beforeSend(attempt: ReplyAttempt): string | undefined {
    const live = this.live(attempt.origin);
    if (live) return live;
    const snapshot = this.#snapshots.get(attempt.origin.token)!;
    if (snapshot.proofRequired && !snapshot.validateProof) return "missing_native_proof_validator";
    try { if (snapshot.validateState?.() === false) return "stale_native_lease"; }
    catch { return "stale_native_lease"; }
    return attempt.ticket && this.#clock() >= attempt.ticket.expires ? "expired_reply_ticket" : undefined;
  }
  prepare(origin: ReplyOrigin, cid: string, peer: string, basis: number, renewal = false): {
    authorization: ReplyAuthorization; valid: () => boolean; activate: () => boolean; discard: () => void;
  } | undefined {
    if (this.live(origin)) return undefined;
    const active = [...this.#tickets.values()].filter(t => t.token === origin.token);
    // Spent tickets stay until retire, and follow-ups share this map,
    // so spending one does not free a slot of this 256-record cap.
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
        this.#recordIssued(ticket);
        return true;
      },
    };
  }
}

interface Handoff {
  prepare?: () => void;
  live: () => boolean;
  commit: () => void;
  rollback: () => void;
}
const handoffs = new WeakMap<ToolResult, Handoff>();
export function bindToolResultHandoff(result: ToolResult, handoff: Handoff): ToolResult {
  handoffs.set(result, handoff); return result;
}
export function appendToolResultHandoff(result: ToolResult, handoff: Handoff): ToolResult {
  const prior = handoffs.get(result);
  return bindToolResultHandoff(result, {
    prepare: () => { prior?.prepare?.(); handoff.prepare?.(); },
    live: () => (prior?.live() ?? true) && handoff.live(),
    commit: () => { handoff.commit(); prior?.commit(); },
    rollback: () => { handoff.rollback(); prior?.rollback(); },
  });
}
/** Called at each real adapter's write/return boundary, never at handler completion. */
export function handoffToolResult(result: ToolResult, write: () => void): boolean {
  const pending = handoffs.get(result);
  handoffs.delete(result);
  try { pending?.prepare?.(); } catch (error) { pending?.rollback(); throw error; }
  if (pending && !pending.live()) { pending.rollback(); return false; }
  try { write(); } catch (error) { pending?.rollback(); throw error; }
  pending?.commit();
  return true;
}
export function discardToolResult(result: ToolResult): void {
  const pending = handoffs.get(result); handoffs.delete(result); pending?.rollback();
}
