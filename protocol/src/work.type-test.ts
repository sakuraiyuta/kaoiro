import type {
  OutboundInterAgentMessagePayload,
  WorkControl,
  WorkErrorCode,
  DeliveryStageReport,
  DeliveryStageRecord,
  YieldClaimRequest,
  YieldToken,
  WorkRecord,
  WorkStatusResult,
  WorkTransferAckRequest,
} from "./index.js";

const base: OutboundInterAgentMessagePayload = {
  to: "peer",
  conversation_id: "conversation",
  turn_number: 1,
  kind: "request",
  body: "Please review",
  meta: { done: false, propose_next: "" },
  owner: { kind: "user", id: "operator" },
  new_conversation: false,
};

const stamped: OutboundInterAgentMessagePayload = {
  ...base,
  // @ts-expect-error A sender cannot construct a server-owned authority stamp.
  delivery_authority: { requested: "yield", granted: "yield" },
};

const submit: WorkControl = {
  op: "submit",
  work_id: "wrk_123",
  operation_id: "op_123",
  basis_revision: 1,
  subject: { hash: "sha256:123", label: "artifact" },
};

// @ts-expect-error A submission needs the revision it observed.
const staleSubmit: WorkControl = { op: "submit", work_id: "wrk_123", operation_id: "op_123", subject: { hash: "sha256:123", label: "artifact" } };

// @ts-expect-error Error codes are a closed Appendix B vocabulary.
const unknownError: WorkErrorCode = "made_up_work_error";

type WorkListResult = Extract<WorkStatusResult, { works: WorkRecord[] }>;
type RestrictedTransferResult = Extract<WorkStatusResult, { access: "transfer_pending" }>;

function acknowledgeFromStatus(status: WorkListResult): WorkTransferAckRequest {
  const pending = status.pending_transfers[0]!;
  return { version: "0", work_id: pending.work_id, transfer_id: pending.transfer_id };
}

const restricted: RestrictedTransferResult = {
  work_id: "wrk_123",
  access: "transfer_pending",
  pending_transfers: [],
};

const restrictedWithFullRecord: RestrictedTransferResult = {
  ...restricted,
  // @ts-expect-error Former assignees cannot receive a complete work record.
  work: {} as WorkRecord,
};

const uuidGeneration = "879d0396-2b61-48d8-adb9-d00e4e4d50be";
const stageGeneration: DeliveryStageReport["generation"] = uuidGeneration;
const recordGeneration: DeliveryStageRecord["generation"] = uuidGeneration;
const claimGeneration: YieldClaimRequest["generation"] = uuidGeneration;
const tokenGeneration: NonNullable<YieldToken["claimed_by"]>["generation"] = uuidGeneration;
// @ts-expect-error A numeric generation cannot identify a wrapper delivery generation.
const numericGeneration: DeliveryStageReport["generation"] = 1;

void stamped;
void submit;
void staleSubmit;
void unknownError;
void acknowledgeFromStatus;
void restrictedWithFullRecord;
void stageGeneration;
void recordGeneration;
void claimGeneration;
void tokenGeneration;
void numericGeneration;
