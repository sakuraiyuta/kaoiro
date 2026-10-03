import type { Envelope } from "./types.js";
import { MAX_PENDING_LOSS_NOTICE_ITEMS } from "./inter_agent_admission.js";
import type { InterAgentDeliveryIdentity } from "./inter_agent_admission.js";

export type InterAgentRetirementCapability = "pending" | "supported" | "unsupported";
export type InterAgentNoticeOutcome = "accepted" | "rejected" | "unknown";

export async function settleOverloadedInbound(options: {
  envelope: Envelope;
  notice?: Envelope;
  lossId?: string;
  retirementAttemptCount?: number;
  controlReservationCount?: number;
  deliveryIdentity?: InterAgentDeliveryIdentity;
  sendNotice?: (notice: Envelope) => Promise<InterAgentNoticeOutcome>;
  retirementCapability?: () => InterAgentRetirementCapability;
  retireDelivery?: (envelope: Envelope) => boolean;
  acknowledgeDelivery?: (envelope: Envelope) => void;
  settleStage?: (envelope: Envelope, reason: "receiver_overloaded") => void;
  log?: (line: string) => void;
}): Promise<void> {
  let notificationOutcome: "accepted" | "rejected" | "unknown" | "not_applicable" = "not_applicable";
  if (options.notice !== undefined) {
    try {
      notificationOutcome = await (options.sendNotice?.(options.notice) ?? Promise.resolve("unknown"));
    } catch {
      notificationOutcome = "unknown";
    }
  }
  let retirementRequestOutcome: "not_requested" | "requested" | "unsupported" | "pending" | "failed" = "not_requested";
  let capability: InterAgentRetirementCapability = "pending";

  if (notificationOutcome !== "accepted") {
    capability = options.retirementCapability?.() ?? "pending";
    if (capability === "supported") {
      retirementRequestOutcome = options.retireDelivery?.(options.envelope) === true
        ? "requested"
        : "failed";
    } else if (capability === "unsupported") {
      retirementRequestOutcome = "unsupported";
      options.acknowledgeDelivery?.(options.envelope);
    } else {
      retirementRequestOutcome = "pending";
    }
  } else {
    options.acknowledgeDelivery?.(options.envelope);
  }

  const acknowledgementOutcome = notificationOutcome === "accepted"
    ? "intentional_non_injection_after_notice"
    : retirementRequestOutcome === "unsupported"
      ? "intentional_non_injection_retirement_unsupported"
      : retirementRequestOutcome === "requested" || retirementRequestOutcome === "failed"
        ? "held_for_retirement_recovery"
        : "held_pending_retirement_capability";
  const sequence = (options.envelope as Envelope & { delivery_seq?: unknown }).delivery_seq;

  options.settleStage?.(options.envelope, "receiver_overloaded");
  options.log?.(`${JSON.stringify({
    event: "receiver_overloaded",
    reason: options.lossId === undefined
      ? options.notice === undefined ? "unattributable_or_error_notice_backlog_full" : "ordinary_backlog_full"
      : "loss_notice_control_allowance_exhausted",
    ...(typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0 ? { delivery_seq: sequence } : {}),
    ...(options.lossId === undefined ? {} : { loss_id: options.lossId }),
    ...(options.deliveryIdentity === undefined ? {} : { delivery_identity: options.deliveryIdentity }),
    ...(options.retirementAttemptCount === undefined ? {} : { retirement_attempt_count: options.retirementAttemptCount }),
    ...(options.controlReservationCount === undefined ? {} : { control_reservations: options.controlReservationCount, control_limit: MAX_PENDING_LOSS_NOTICE_ITEMS }),
    notice_dispatch_outcome: notificationOutcome,
    notification_outcome: retirementRequestOutcome === "unsupported" ? "not_confirmed" : notificationOutcome,
    retirement_request_outcome: retirementRequestOutcome,
    retirement_capability: capability,
    acknowledgement_outcome: acknowledgementOutcome,
    retirement_unsupported: capability === "unsupported",
    automatic_loss_recovery_available: capability === "supported",
    server_recovery_outcome: "unknown",
  })}\n`);
}
