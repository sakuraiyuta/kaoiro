import type { OutboundInterAgentMessagePayload, WorkControl, WorkErrorCode } from "./index.js";

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

void stamped;
void submit;
void staleSubmit;
void unknownError;
