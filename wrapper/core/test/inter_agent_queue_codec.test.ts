import { describe, expect, it } from "vitest";
import {
  parseDeliveryBatchPush,
  parseDeliveryQueueControlError,
  parseDeliveryQueueControlReply,
  parseInterAgentQueueCounts,
  parseInterAgentQueueJoinError,
  parseInterAgentQueueJoinReply,
  parseInterAgentQueueRecovery,
  parseInterAgentQueueSendError,
} from "../src/inter_agent_queue_codec.js";

const policy = { batch_max_items: 10, backlog_max_items: 100, backlog_max_bytes: 524_288 };
const counts = { queued: 1, offered: 0, native_pending: 0, waiter: 0, control: 0, charged_bytes: 5, policy };
const envelope = { version: "0", type: "inter_agent_message", agent_id: "peer", payload: { body: "hi" } };
const item = { queue_id: "q1", attempt_id: "a1", delivery_seq: 7, class: "ordinary", byte_charge: 2, envelope };

describe("inter-agent queue codec", () => {
  it("accepts a join reply and drops unknown fields", () => {
    const reply = {
      inter_agent_queue: "credit-v1",
      inter_agent_queue_policy: { ...policy, extra: 1 },
      inter_agent_queue_epoch: "e",
      inter_agent_queue_resume_required: false,
      hydration: {},
    };
    expect(parseInterAgentQueueJoinReply(reply)).toEqual({
      inter_agent_queue: "credit-v1",
      inter_agent_queue_policy: policy,
      inter_agent_queue_epoch: "e",
      inter_agent_queue_resume_required: false,
    });
    expect(parseInterAgentQueueJoinReply({ ...reply, inter_agent_inline_recovery: "v1" })?.inter_agent_inline_recovery)
      .toBe("v1");
  });

  it.each([
    ["no echo", { inter_agent_queue: undefined }],
    ["fractional policy", { inter_agent_queue_policy: { ...policy, batch_max_items: 1.5 } }],
    ["empty epoch", { inter_agent_queue_epoch: "" }],
    ["resume flag as string", { inter_agent_queue_resume_required: "false" }],
    ["unknown inline recovery", { inter_agent_inline_recovery: "v2" }],
  ])("rejects a join reply with %s", (_label, change) => {
    const reply = {
      inter_agent_queue: "credit-v1",
      inter_agent_queue_policy: policy,
      inter_agent_queue_epoch: "e",
      inter_agent_queue_resume_required: false,
      ...change,
    };
    expect(parseInterAgentQueueJoinReply(reply)).toBeUndefined();
  });

  it("parses both join errors and nothing else", () => {
    expect(parseInterAgentQueueJoinError({ reason: "queue_capability_required", missing: ["delivery_resync"] }))
      .toEqual({ reason: "queue_capability_required", missing: ["delivery_resync"] });
    expect(parseInterAgentQueueJoinError({
      reason: "invalid_queue_policy", field: "backlog_max_bytes", detail: "above_ceiling", limit: 16_384,
    })).toEqual({ reason: "invalid_queue_policy", field: "backlog_max_bytes", detail: "above_ceiling", limit: 16_384 });
    expect(parseInterAgentQueueJoinError({ reason: "invalid_queue_policy", field: "other", detail: "missing" }))
      .toBeUndefined();
    expect(parseInterAgentQueueJoinError({ reason: "forbidden" })).toBeUndefined();
  });

  it("requires every count to be a non-negative integer", () => {
    expect(parseInterAgentQueueCounts(counts)).toEqual(counts);
    expect(parseInterAgentQueueCounts({ ...counts, waiter: -1 })).toBeUndefined();
    expect(parseInterAgentQueueCounts({ ...counts, policy: undefined })).toBeUndefined();
  });

  describe("delivery_batch", () => {
    const push = {
      version: "0", queue_epoch: "e", incarnation: "i", generation: "g", lease_id: "l1",
      kind: "root", credit_revision: "c1", items: [item],
    };

    it("accepts a root offer", () => {
      expect(parseDeliveryBatchPush(push)).toEqual(push);
    });

    it("binds credit_revision to root and early, registration_id to waiter", () => {
      expect(parseDeliveryBatchPush({ ...push, kind: "waiter" })).toBeUndefined();
      expect(parseDeliveryBatchPush({ ...push, registration_id: "r" })).toBeUndefined();
      const { credit_revision: _drop, ...waiter } = push;
      expect(parseDeliveryBatchPush({ ...waiter, kind: "waiter", registration_id: "r" })?.registration_id).toBe("r");
    });

    it.each([
      ["no items", { items: [] }],
      ["a zero sequence", { items: [{ ...item, delivery_seq: 0 }] }],
      ["an unknown class", { items: [{ ...item, class: "urgent" }] }],
      ["a non-message envelope", { items: [{ ...item, envelope: { ...envelope, type: "task" } }] }],
      ["another version", { version: "1" }],
    ])("rejects %s", (_label, change) => {
      expect(parseDeliveryBatchPush({ ...push, ...change })).toBeUndefined();
    });
  });

  describe("control replies", () => {
    const base = { operation_id: "op_1", queue: counts };

    it("parses each op's reply", () => {
      expect(parseDeliveryQueueControlReply({ ...base, op: "credit", credit_revision: "c" }, "credit"))
        .toEqual({ ...base, op: "credit", credit_revision: "c" });
      expect(parseDeliveryQueueControlReply(
        { ...base, op: "dispose", disposed: ["q1"], resolved_ranges: [[1, 2]], returned_ranges: [] },
        "dispose",
      )?.resolved_ranges).toEqual([[1, 2]]);
      expect(parseDeliveryQueueControlReply({
        ...base, op: "resume",
        leases: [{ lease_id: "l", items: [{ queue_id: "q1", phase: "native_pending" }] }],
        registrations: [{ registration_id: "r", active: true }],
      }, "resume")?.leases[0]?.items[0]?.phase).toBe("native_pending");
      expect(parseDeliveryQueueControlReply({ ...base, op: "freeze", frozen: true }, "freeze")?.frozen).toBe(true);
    });

    it("rejects a reply for another op or with a malformed body", () => {
      expect(parseDeliveryQueueControlReply({ ...base, op: "withdraw", withdrawn: true }, "credit")).toBeUndefined();
      expect(parseDeliveryQueueControlReply({ ...base, op: "return", returned_ranges: [[3, 2]] }, "return"))
        .toBeUndefined();
      expect(parseDeliveryQueueControlReply({ ...base, op: "freeze", frozen: false }, "freeze")).toBeUndefined();
      expect(parseDeliveryQueueControlReply({ op: "credit", operation_id: "op_1", credit_revision: "c" }, "credit"))
        .toBeUndefined();
    });

    it("parses control errors", () => {
      expect(parseDeliveryQueueControlError({ reason: "queue_frozen" })).toEqual({ reason: "queue_frozen" });
      expect(parseDeliveryQueueControlError({ reason: "operation_superseded", items: [{ queue_id: "q", phase: "terminal" }] }))
        .toEqual({ reason: "operation_superseded", items: [{ queue_id: "q", phase: "terminal" }] });
      expect(parseDeliveryQueueControlError({ reason: "operation_superseded" })).toBeUndefined();
      expect(parseDeliveryQueueControlError({ reason: "invalid_queue_control", field: "lease_id" }))
        .toEqual({ reason: "invalid_queue_control", field: "lease_id" });
      expect(parseDeliveryQueueControlError({ reason: "nope" })).toBeUndefined();
    });
  });

  it("parses send errors and recovery", () => {
    expect(parseInterAgentQueueSendError({ reason: "receiver_overloaded", from: "b", message: "m" }))
      .toEqual({ reason: "receiver_overloaded", from: "b", message: "m" });
    expect(parseInterAgentQueueSendError({ reason: "delivery_unavailable", delivered: true })).toBeUndefined();
    expect(parseInterAgentQueueRecovery({ lease_id: "l", items: [item] })).toEqual({ lease_id: "l", items: [item] });
    expect(parseInterAgentQueueRecovery({ lease_id: "l", items: [{ ...item, queue_id: "" }] })).toBeUndefined();
  });
});
