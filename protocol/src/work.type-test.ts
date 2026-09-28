import type {
  OutboundInterAgentMessagePayload,
  WorkControl,
  WorkErrorCode,
  DeliveryStageReport,
  DeliveryStageRecord,
  DeliveryDowngrade,
  YieldClaimRequest,
  YieldToken,
  WorkRecord,
  WorkStatusResult,
  WorkNotice,
  WorkJoinReply,
  WorkTransferAckResult,
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

// @ts-expect-error Delivery downgrade reasons are a closed wire vocabulary.
const unknownDowngrade: DeliveryDowngrade = "made_up_downgrade";
const yieldTokenUnavailable: DeliveryDowngrade = "yield_token_unavailable";
const joinReplyIncarnation: WorkJoinReply = {
  inter_agent_delivery_modes: "v1",
  inter_agent_delivery_incarnation: "ledger-incarnation",
  work_control: "v1",
};

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

type RestrictedWorkNotice = Extract<WorkNotice, { work: { access: "transfer_pending" } }>;
const restrictedNotice: RestrictedWorkNotice = {
  version: "0",
  op: "transfer",
  reason: "transfer_pending",
  work: { work_id: "wrk_123", access: "transfer_pending", pending_transfers: [] },
};
const restrictedNoticeWithFullWork: RestrictedWorkNotice = {
  ...restrictedNotice,
  work: {
    work_id: "wrk_123",
    access: "transfer_pending",
    pending_transfers: [],
    // @ts-expect-error A restricted transfer notice cannot expose a full record.
    work: {} as WorkRecord,
  },
};
const fullRecordNoticeWork = {
  work_id: "wrk_123",
  access: "transfer_pending" as const,
  pending_transfers: [] as RestrictedWorkNotice["work"]["pending_transfers"],
  work: {} as WorkRecord,
};
// @ts-expect-error Restricted notices must not structurally accept a full work record.
const structurallyFullRestrictedNotice: RestrictedWorkNotice["work"] = fullRecordNoticeWork;

const transferAck: WorkTransferAckResult = {
  work_id: "wrk_123",
  transfer_id: "trf_123",
  state: "acknowledged",
};
const transferAckWithFullWork: WorkTransferAckResult = {
  ...transferAck,
  // @ts-expect-error Transfer acknowledgements expose no full work record.
  work: {} as WorkRecord,
};
const fullRecordAck = {
  work_id: "wrk_123",
  transfer_id: "trf_123",
  state: "acknowledged" as const,
  work: {} as WorkRecord,
};
// @ts-expect-error Transfer acknowledgements must not structurally accept a full work record.
const structurallyFullTransferAck: WorkTransferAckResult = fullRecordAck;

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
void unknownDowngrade;
void yieldTokenUnavailable;
void joinReplyIncarnation;
void acknowledgeFromStatus;
void restrictedWithFullRecord;
void restrictedNoticeWithFullWork;
void structurallyFullRestrictedNotice;
void transferAckWithFullWork;
void structurallyFullTransferAck;
void stageGeneration;
void recordGeneration;
void claimGeneration;
void tokenGeneration;
void numericGeneration;
