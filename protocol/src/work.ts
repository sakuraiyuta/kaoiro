import type { WorkCapacityDiagnostic } from "./work-settings.js";
/** Wire vocabulary for ADR-0063 phase 1. The server owns every grant and receipt. */
export type DeliveryIntent = "normal" | "early" | "yield";
export type WorkId = string;
export type DeliveryEarlyMode = "fold" | "steer" | "hook" | "none";
export type DeliveryYieldMode = "tool_boundary" | "none";

export interface DeliveryModesJoinRequest {
  version: "v1";
  early: DeliveryEarlyMode;
  yield: DeliveryYieldMode;
  stage_reports: boolean;
}

/** Operator-input capability, declared separately from inter-agent early
 *  delivery; `early` decides the server's default operator intent only. */
export interface OperatorInputModesJoinRequest {
  version: "v1";
  early: DeliveryEarlyMode;
}

export interface WorkJoinRequest {
  inter_agent_delivery_modes?: DeliveryModesJoinRequest;
  notice_attribution?: "v1";
  operator_input_modes?: OperatorInputModesJoinRequest;
  work_control?: "v1";
}

export interface WorkJoinReply {
  inter_agent_delivery_modes?: "v1";
  notice_attribution?: "v1";
  operator_input_modes?: "v1";
  inter_agent_delivery_incarnation?: string;
  work_control?: "v1";
}

export interface DeliveryModes {
  early: DeliveryEarlyMode;
  yield: DeliveryYieldMode;
  stage_reports: boolean;
}

export type DeliveryDowngrade =
  | "recipient_policy_off"
  | "policy_unknown"
  | "policy_unconfirmed"
  | "unsupported_by_recipient"
  | "yield_not_authorized"
  | "yield_interval"
  | "yield_capacity"
  | "yield_token_unavailable"
  | "early_quota"
  | "recipient_legacy";

export interface DeliveryAuthority {
  requested: DeliveryIntent;
  granted: DeliveryIntent;
  downgrade?: DeliveryDowngrade;
  work_id?: string;
  authority_epoch?: number;
  yield_token?: string;
}

export interface DeliveryAdvisory {
  recipient_state: string;
  granted: DeliveryIntent;
  downgrade?: DeliveryDowngrade;
  /** Unknown future values must be projected as `unknown` by the reader. */
  mechanism: "queue" | "fold" | "cut" | "steer" | "hook" | "unknown";
  unresolved_count: number;
  guidance: string;
}

/** Successful wrapper-channel acknowledgement for an inter-agent send.
 *  New fields are optional so a current wrapper can still read an older server reply. */
export interface InterAgentSendReply {
  ingress_stamp: [number, number];
  delivery_authority?: DeliveryAuthority;
  delivery?: { advisory: DeliveryAdvisory };
  work_control_result?: WorkControlResult;
}

export interface InterAgentSendRejection {
  reason: string;
  send_not_attempted?: true;
  details?: {
    capacity?: WorkCapacityDiagnostic;
    operation_id?: string;
    work_id?: string;
    conversation_id?: string;
    delivery?: "recorded" | "not_recorded" | "unknown";
    work_control_result?: WorkControlResult;
  };
}

export interface WorkStamp {
  work_id: string;
  revision: number;
  authority_epoch: number;
  state: WorkState;
}

export type WorkPrincipal =
  | { kind: "agent"; id: string }
  | { kind: "user"; id: string };

export type WorkState = "nominated" | "active" | "completed" | "cancelled" | "declined" | "expired";
export type WorkTransferState = "pending" | "acknowledged" | "overridden";
export type WorkVerdictOutcome = "approve" | "request_changes" | "reject";
export type WorkVerdictState = "recorded" | "withdrawn" | "superseded" | "invalidated";
export type WorkCheckAction = "start" | "land";

export interface WorkTransferObligation {
  transfer_id: string;
  epoch: number;
  old_assignee: WorkPrincipal;
  new_assignee: WorkPrincipal;
  state: WorkTransferState;
}

/** A former assignee can acknowledge a transfer without seeing the work record. */
export type PendingWorkTransfer = WorkTransferObligation & { work_id: WorkId };

export interface WorkGrant {
  work_id: string;
  director: WorkPrincipal;
  assignee: { kind: "agent"; id: string };
  resource_scope: string[];
  authority_epoch: number;
  state: "active";
}

export interface WorkSubject {
  hash: string;
  label: string;
  seq: number;
}

export interface WorkVerdictRef {
  work_id: string;
  verdict_id: string;
}

export interface WorkVerdict {
  verdict_id: string;
  author: WorkPrincipal;
  subject: { work_id: string; hash: string };
  outcome: WorkVerdictOutcome;
  basis_revision: number;
  state: WorkVerdictState;
}

export interface WorkAcceptedVerdict {
  verdict_ref: WorkVerdictRef;
  subject_hash: string;
  at_revision: number;
  void?: "subject_changed";
}

export interface WorkHold {
  hold_id: string;
  reason: string;
  set_at_revision: number;
}

export interface WorkCheckTarget {
  ref: string;
  expected_old: string;
  actual?: string;
}

export interface WorkCheckAudit {
  principal: WorkPrincipal;
  action: WorkCheckAction;
  revision: number;
  subject_hash?: string | null;
  result: "ok" | WorkErrorCode | "stale_work_revision" | "subject_mismatch" | "transfer_pending" | "verdict_not_effective";
  at: string;
  target?: WorkCheckTarget | null;
}

export interface WorkRecord {
  work_id: string;
  title: string;
  origin?: { conversation_id: string; turn_number: number } | null;
  reviews?: string | null;
  director: WorkPrincipal;
  assignee: { kind: "agent"; id: string };
  resource_scope: string[];
  requires_verdict?: boolean;
  state: WorkState;
  revision: number;
  authority_epoch: number;
  transfers?: WorkTransferObligation[];
  subject?: WorkSubject | null;
  holds?: WorkHold[];
  verdicts?: WorkVerdict[];
  accepted_verdicts?: WorkAcceptedVerdict[];
  links: string[];
  receipts: WorkOperationReceipt[];
  checks?: WorkCheckAudit[];
  created_at: string;
  updated_at: string;
}

interface WorkOperationBase {
  operation_id: string;
}

interface ExistingWorkOperation extends WorkOperationBase {
  work_id: string;
}

export type WorkControl =
  | (WorkOperationBase & { op: "assign"; title: string; assignee?: string; director?: WorkPrincipal; resource_scope?: string[] })
  | (ExistingWorkOperation & { op: "accept_assignment" | "decline" | "complete" | "cancel" });

export type WorkControlOp = WorkControl["op"];
/** Persisted receipts and queued inbound messages can still name retired operations. */
export type WorkReceiptOp = WorkControlOp | "revise" | "hold" | "release" | "submit" |
  "verdict" | "withdraw_verdict" | "accept_verdict" | "revoke_verdict" | "transfer" | "release_transfer";
export type WorkDeliveryKnowledge =
  | { status: "not_recorded"; reason: string }
  | { status: "recorded"; conversation_id: string; turn_number: number };

export interface WorkOperationReceipt {
  principal: WorkPrincipal;
  operation_id: string;
  op_digest: string;
  result: WorkControlResult;
  delivery?: WorkDeliveryKnowledge;
  issued_at_ms: number;
}

export interface WorkControlResult {
  op: WorkReceiptOp;
  operation_id: string;
  outcome: "applied";
  deduplicated?: true;
  work?: WorkStamp;
  claimed_yield_tokens?: string[];
}

export interface WorkError {
  code: WorkErrorCode;
  work_id?: string;
  operation_id?: string;
  current_revision?: number;
  supplied?: number;
  result?: WorkControlResult;
  conversation_error?: string;
}

export type WorkErrorCode =
  | "unsupported_work_operation"
  | "work_not_authorized"
  | "unknown_work"
  | "work_state_conflict"
  | "work_link_conflict"
  | "work_carriage_invalid"
  | "operation_id_conflict"
  | "operation_id_expired"
  | "unknown_operation"
  | "work_capacity"
  | "work_settings_corrupt"
  | "work_settings_unknown"
  | "work_outcome_unknown"
  | "work_applied_message_rejected"
  | "invalid_delivery_stage"
  | "work_control_unavailable";

export interface DeliveryStageReport {
  version: "0";
  incarnation: string;
  generation: string;
  delivery_seq: number;
  stage: "queued" | "submitted" | "included" | "settled" | "unknown";
  mode?: "normal" | "early" | "yield";
  handoff?: "prompt_hook" | "fold_hook" | "exec_input_written" | "turn_start_accepted" | "tool_result" |
    "turn_steer_accepted" | "turn_steer_item_observed" | "turn_steer_write_uncertain";
  evidence?: "ticket_used";
  reason?: string;
  yield_disposition?: YieldDisposition;
  at: string;
}

export interface YieldDisposition {
  outcome: "cut" | "downgraded";
  reason?: string;
  at: string;
}

export interface YieldToken {
  yield_token: string;
  recipient: string;
  conversation_id: string;
  turn_number: number;
  work_id: string;
  authority_epoch: number;
  admitted_at: string;
  expires_at: string;
  state: "unclaimed" | "claimed";
  claimed_by?: { incarnation: string; generation: string };
  claimed_at?: string;
}

export interface DeliveryStageRecord {
  conversation_id: string;
  turn_number: number;
  recipient: string;
  incarnation: string;
  generation: string;
  delivery_seq: number;
  stages: Partial<Record<"accepted" | "queued" | "submitted" | "included" | "settled" | "unknown" | "lost", string>>;
  mode?: DeliveryIntent;
  handoff?: DeliveryStageReport["handoff"];
  evidence?: DeliveryStageReport["evidence"];
  reason?: string;
  yield_disposition?: YieldDisposition;
}

export type DeliveryStatusResult = DeliveryStageRecord | { status: "expired" };
export type YieldDispositionRead = YieldDisposition | { outcome: "unknown" | "expired" };

export interface YieldClaimRequest {
  version: "0";
  incarnation: string;
  generation: string;
  yield_token: string;
  conversation_id: string;
  turn_number: number;
  work_id: string;
  authority_epoch: number;
}

export type YieldClaimResult =
  | { granted: true; repeated?: true }
  | { granted: false; reason: "unknown_yield" | "already_claimed" | "work_not_active" | "not_assignee" | "grant_changed" | "yield_interval" | "stale_channel" };

export interface WorkOpResultRequest { version: "0"; operation_id: string }
export interface WorkStatusRequest { version: "0"; work_id?: string }
export type WorkStatusResult =
  | { work: WorkRecord }
  | { work_id: WorkId; access: "transfer_pending"; pending_transfers: PendingWorkTransfer[]; work?: never }
  | { works: WorkRecord[]; pending_transfers: PendingWorkTransfer[] };
export type WorkOpResult = { receipt: WorkOperationReceipt } | { error: "unknown_operation" | "operation_id_expired" };
export interface DeliveryStatusRequest { version: "0"; conversation_id?: string; turn_number?: number }

export interface OperatorWorkControlRequest { version: "0"; work_control: WorkControl }
interface WorkNoticeFields { version: "0"; op: WorkReceiptOp; reason: string; transfer_id?: string }
export type WorkNotice =
  | (WorkNoticeFields & { work: WorkRecord })
  | (WorkNoticeFields & {
    work: {
      work_id: WorkId;
      access: "transfer_pending";
      pending_transfers: PendingWorkTransfer[];
      work?: never;
    };
  });
export interface WorkChanged { version: "0"; work: WorkRecord }
export interface WorkScopeOverlap { version: "0"; work_id: string; other_work_id: string; scopes: string[] }
export interface OperatorInstruction { version: "0"; agent_id: string; text: string; attachment_ids?: string[]; delivery_intent?: DeliveryIntent }
