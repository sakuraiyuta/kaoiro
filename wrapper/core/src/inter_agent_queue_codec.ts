// Runtime validators for the server-to-wrapper `credit-v1` queue shapes
// (docs/reference/protocol/channels.md, server-owned inter-agent queue).
// The shapes are the @kaoiro/protocol types, imported as types only: the
// protocol package ships no runtime code. Each validator returns that type
// or undefined, and copies only the known fields.
//
// Every validated shape lists its keys, and a compile-time check requires
// the list to equal the protocol type's keys. A field added to a protocol
// type therefore fails typecheck here until the validator handles it.

import type {
  DeliveryBatchPush,
  DeliveryQueueControlError,
  DeliveryQueueControlReply,
  Envelope,
  InterAgentQueueCounts,
  InterAgentQueueItem,
  InterAgentQueueItemPhase,
  InterAgentQueueJoinError,
  InterAgentQueueJoinReply,
  InterAgentQueuePolicy,
  InterAgentQueueRecovery,
  InterAgentQueueSendError,
} from "@kaoiro/protocol";

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type KeysOf<T> = T extends unknown ? keyof T : never;
type Variant<U, Op> = Extract<U, { op: Op }>;

/** Compile-time only: `keys` must name exactly the keys of `T`. */
function keys<T>() {
  return <const K extends readonly PropertyKey[]>(
    list: K & (Exactly<K[number], KeysOf<T>> extends true ? unknown : never),
  ): K => list;
}

const POLICY_KEYS = keys<InterAgentQueuePolicy>()([
  "batch_max_items",
  "backlog_max_items",
  "backlog_max_bytes",
]);
const JOIN_REPLY_KEYS = keys<InterAgentQueueJoinReply>()([
  "inter_agent_queue",
  "inter_agent_queue_policy",
  "inter_agent_queue_epoch",
  "inter_agent_inline_recovery",
  "inter_agent_queue_resume_required",
]);
const COUNTS_KEYS = keys<InterAgentQueueCounts>()([
  "queued",
  "offered",
  "native_pending",
  "waiter",
  "control",
  "charged_bytes",
  "policy",
]);
const ITEM_KEYS = keys<InterAgentQueueItem>()([
  "queue_id",
  "attempt_id",
  "delivery_seq",
  "class",
  "byte_charge",
  "envelope",
]);
const BATCH_KEYS = keys<DeliveryBatchPush>()([
  "version",
  "queue_epoch",
  "incarnation",
  "generation",
  "lease_id",
  "kind",
  "credit_revision",
  "registration_id",
  "items",
]);
const PHASE_KEYS = keys<InterAgentQueueItemPhase>()(["queue_id", "phase"]);
const RECOVERY_KEYS = keys<InterAgentQueueRecovery>()(["lease_id", "items"]);
const JOIN_ERROR_KEYS = keys<InterAgentQueueJoinError>()([
  "reason",
  "missing",
  "field",
  "detail",
  "limit",
]);
const SEND_ERROR_KEYS = keys<InterAgentQueueSendError>()([
  "reason",
  "from",
  "message",
  "delivered",
]);
const CONTROL_ERROR_KEYS = keys<DeliveryQueueControlError>()(["reason", "items", "field"]);
const REPLY_KEYS = {
  credit: keys<Variant<DeliveryQueueControlReply, "credit">>()([
    "op", "operation_id", "queue", "credit_revision",
  ]),
  withdraw: keys<Variant<DeliveryQueueControlReply, "withdraw">>()([
    "op", "operation_id", "queue", "withdrawn",
  ]),
  begin_native: keys<Variant<DeliveryQueueControlReply, "begin_native">>()([
    "op", "operation_id", "queue", "permitted_queue_ids",
  ]),
  return: keys<Variant<DeliveryQueueControlReply, "return">>()([
    "op", "operation_id", "queue", "returned_ranges",
  ]),
  dispose: keys<Variant<DeliveryQueueControlReply, "dispose">>()([
    "op", "operation_id", "queue", "disposed", "resolved_ranges", "returned_ranges",
  ]),
  waiter_close: keys<Variant<DeliveryQueueControlReply, "waiter_close">>()([
    "op", "operation_id", "queue", "closed", "claimed",
  ]),
  resume: keys<Variant<DeliveryQueueControlReply, "resume">>()([
    "op", "operation_id", "queue", "leases", "registrations",
  ]),
  freeze: keys<Variant<DeliveryQueueControlReply, "freeze">>()([
    "op", "operation_id", "queue", "frozen",
  ]),
} as const;

/** Exported for the key-list tests; not part of the validators' contract. */
export const INTER_AGENT_QUEUE_CODEC_KEYS = {
  POLICY_KEYS,
  JOIN_REPLY_KEYS,
  COUNTS_KEYS,
  ITEM_KEYS,
  BATCH_KEYS,
  PHASE_KEYS,
  RECOVERY_KEYS,
  JOIN_ERROR_KEYS,
  SEND_ERROR_KEYS,
  CONTROL_ERROR_KEYS,
  REPLY_KEYS,
};

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function listOf<T>(value: unknown, parse: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

const parseId = (value: unknown): string | undefined => (isId(value) ? value : undefined);

function parseRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [first, last] = value as unknown[];
  return isCount(first) && isCount(last) && first >= 1 && first <= last ? [first, last] : undefined;
}

export function parseInterAgentQueuePolicy(value: unknown): InterAgentQueuePolicy | undefined {
  if (!isObject(value)) return undefined;
  const { batch_max_items, backlog_max_items, backlog_max_bytes } = value;
  if (!isCount(batch_max_items) || !isCount(backlog_max_items) || !isCount(backlog_max_bytes)) return undefined;
  return { batch_max_items, backlog_max_items, backlog_max_bytes };
}

export function parseInterAgentQueueJoinReply(value: unknown): InterAgentQueueJoinReply | undefined {
  if (!isObject(value) || value.inter_agent_queue !== "credit-v1") return undefined;
  const policy = parseInterAgentQueuePolicy(value.inter_agent_queue_policy);
  const epoch = value.inter_agent_queue_epoch;
  const resume = value.inter_agent_queue_resume_required;
  const inline = value.inter_agent_inline_recovery;
  if (policy === undefined || !isId(epoch) || typeof resume !== "boolean") return undefined;
  if (inline !== undefined && inline !== "v1") return undefined;
  return {
    inter_agent_queue: "credit-v1",
    inter_agent_queue_policy: policy,
    inter_agent_queue_epoch: epoch,
    ...(inline === "v1" ? { inter_agent_inline_recovery: "v1" as const } : {}),
    inter_agent_queue_resume_required: resume,
  };
}

const POLICY_FIELDS = [...POLICY_KEYS, "inter_agent_queue_policy"] as const;
const POLICY_DETAILS = ["missing", "not_integer", "below_minimum", "above_ceiling", "generation_mismatch"] as const;

export function parseInterAgentQueueJoinError(value: unknown): InterAgentQueueJoinError | undefined {
  if (!isObject(value)) return undefined;
  if (value.reason === "queue_capability_required") {
    const missing = listOf(value.missing, parseId);
    return missing === undefined ? undefined : { reason: "queue_capability_required", missing };
  }
  if (value.reason === "invalid_queue_policy") {
    const { field, detail, limit } = value;
    if (!oneOf(field, POLICY_FIELDS) || !oneOf(detail, POLICY_DETAILS)) return undefined;
    if (limit !== undefined && !isCount(limit)) return undefined;
    return { reason: "invalid_queue_policy", field, detail, ...(limit === undefined ? {} : { limit }) };
  }
  return undefined;
}

export function parseInterAgentQueueCounts(value: unknown): InterAgentQueueCounts | undefined {
  if (!isObject(value)) return undefined;
  const { queued, offered, native_pending, waiter, control, charged_bytes } = value;
  const policy = parseInterAgentQueuePolicy(value.policy);
  if (
    !isCount(queued) || !isCount(offered) || !isCount(native_pending) ||
    !isCount(waiter) || !isCount(control) || !isCount(charged_bytes) || policy === undefined
  ) return undefined;
  return { queued, offered, native_pending, waiter, control, charged_bytes, policy };
}

/** The envelope is checked only for its shape here; the wrapper's inbound
 *  path validates it as it does for every other delivered envelope. */
function parseItem(value: unknown): InterAgentQueueItem | undefined {
  if (!isObject(value)) return undefined;
  const { queue_id, attempt_id, delivery_seq, byte_charge, envelope } = value;
  if (!isId(queue_id) || !isId(attempt_id) || !isCount(delivery_seq) || delivery_seq < 1) return undefined;
  if (!oneOf(value.class, ["ordinary", "waiter", "control"] as const) || !isCount(byte_charge)) return undefined;
  if (!isObject(envelope) || envelope.type !== "inter_agent_message") return undefined;
  return {
    queue_id,
    attempt_id,
    delivery_seq,
    class: value.class,
    byte_charge,
    envelope: envelope as unknown as Envelope,
  };
}

export function parseDeliveryBatchPush(value: unknown): DeliveryBatchPush | undefined {
  if (!isObject(value) || value.version !== "0") return undefined;
  const { queue_epoch, incarnation, generation, lease_id, kind, credit_revision, registration_id } = value;
  if (!isId(queue_epoch) || !isId(incarnation) || !isId(generation) || !isId(lease_id)) return undefined;
  if (!oneOf(kind, ["root", "early", "waiter"] as const)) return undefined;
  if (kind === "waiter" ? !isId(registration_id) || credit_revision !== undefined
    : !isId(credit_revision) || registration_id !== undefined) return undefined;
  const items = listOf(value.items, parseItem);
  if (items === undefined || items.length === 0) return undefined;
  return {
    version: "0",
    queue_epoch,
    incarnation,
    generation,
    lease_id,
    kind,
    ...(kind === "waiter" ? { registration_id: registration_id as string } : { credit_revision: credit_revision as string }),
    items,
  };
}

function parsePhase(value: unknown): InterAgentQueueItemPhase | undefined {
  if (!isObject(value) || !isId(value.queue_id)) return undefined;
  if (!oneOf(value.phase, ["queued", "offered", "native_pending", "terminal"] as const)) return undefined;
  return { queue_id: value.queue_id, phase: value.phase };
}

export function parseInterAgentQueueRecovery(value: unknown): InterAgentQueueRecovery | undefined {
  if (!isObject(value) || !isId(value.lease_id)) return undefined;
  const items = listOf(value.items, parseItem);
  return items === undefined ? undefined : { lease_id: value.lease_id, items };
}

export function parseInterAgentQueueSendError(value: unknown): InterAgentQueueSendError | undefined {
  if (!isObject(value)) return undefined;
  if (value.reason === "receiver_overloaded" && isId(value.from) && typeof value.message === "string") {
    return { reason: "receiver_overloaded", from: value.from, message: value.message };
  }
  if (value.reason === "delivery_unavailable" && value.delivered === false) {
    return { reason: "delivery_unavailable", delivered: false };
  }
  return undefined;
}

const PLAIN_CONTROL_ERRORS = [
  "stale_queue_epoch",
  "stale_channel",
  "stale_delivery_owner",
  "queue_resume_required",
  "queue_frozen",
  "previous_root_pending",
  "unknown_lease",
  "unknown_queue_item",
  "operation_payload_mismatch",
  "unknown_operation",
  "conflicting_disposition",
  "queue_unavailable",
] as const;

export function parseDeliveryQueueControlError(value: unknown): DeliveryQueueControlError | undefined {
  if (!isObject(value)) return undefined;
  if (oneOf(value.reason, PLAIN_CONTROL_ERRORS)) return { reason: value.reason };
  if (value.reason === "operation_superseded") {
    const items = listOf(value.items, parsePhase);
    return items === undefined ? undefined : { reason: "operation_superseded", items };
  }
  if (value.reason === "invalid_queue_control" && isId(value.field)) {
    return { reason: "invalid_queue_control", field: value.field };
  }
  return undefined;
}

/** Validates a control reply for the op the wrapper sent; a reply for
 *  another op is invalid. */
export function parseDeliveryQueueControlReply<Op extends DeliveryQueueControlReply["op"]>(
  value: unknown,
  op: Op,
): Variant<DeliveryQueueControlReply, Op> | undefined {
  const reply = parseControlReply(value);
  // Sound narrowing: the union is discriminated by `op`.
  return reply?.op === op ? (reply as Variant<DeliveryQueueControlReply, Op>) : undefined;
}

function parseControlReply(value: unknown): DeliveryQueueControlReply | undefined {
  if (!isObject(value) || !isId(value.operation_id)) return undefined;
  const queue = parseInterAgentQueueCounts(value.queue);
  if (queue === undefined) return undefined;
  const operation_id = value.operation_id;
  switch (value.op) {
    case "credit":
      return isId(value.credit_revision)
        ? { op: "credit", operation_id, queue, credit_revision: value.credit_revision }
        : undefined;
    case "withdraw":
      return typeof value.withdrawn === "boolean"
        ? { op: "withdraw", operation_id, queue, withdrawn: value.withdrawn }
        : undefined;
    case "begin_native": {
      const permitted = listOf(value.permitted_queue_ids, parseId);
      return permitted === undefined
        ? undefined
        : { op: "begin_native", operation_id, queue, permitted_queue_ids: permitted };
    }
    case "return": {
      const returned = listOf(value.returned_ranges, parseRange);
      return returned === undefined ? undefined : { op: "return", operation_id, queue, returned_ranges: returned };
    }
    case "dispose": {
      const disposed = listOf(value.disposed, parseId);
      const resolved = listOf(value.resolved_ranges, parseRange);
      const returned = listOf(value.returned_ranges, parseRange);
      return disposed === undefined || resolved === undefined || returned === undefined
        ? undefined
        : { op: "dispose", operation_id, queue, disposed, resolved_ranges: resolved, returned_ranges: returned };
    }
    case "waiter_close":
      return typeof value.closed === "boolean" && typeof value.claimed === "boolean"
        ? { op: "waiter_close", operation_id, queue, closed: value.closed, claimed: value.claimed }
        : undefined;
    case "resume": {
      const leases = listOf(value.leases, (lease) => {
        if (!isObject(lease) || !isId(lease.lease_id)) return undefined;
        const items = listOf(lease.items, parsePhase);
        return items === undefined ? undefined : { lease_id: lease.lease_id, items };
      });
      const registrations = listOf(value.registrations, (registration) =>
        isObject(registration) && isId(registration.registration_id) && typeof registration.active === "boolean"
          ? { registration_id: registration.registration_id, active: registration.active }
          : undefined);
      return leases === undefined || registrations === undefined
        ? undefined
        : { op: "resume", operation_id, queue, leases, registrations };
    }
    case "freeze":
      return value.frozen === true ? { op: "freeze", operation_id, queue, frozen: true } : undefined;
    default:
      return undefined;
  }
}
