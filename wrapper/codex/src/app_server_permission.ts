import { randomUUID } from "node:crypto";
import type { PermissionObservation, PermissionSelection, PermissionSubmission } from "@kaoiro/protocol";
import { effectiveNetworkAccess } from "./network_access.js";
import { canSubmitPermission, isCurrentPermissionExecution, type PermissionState } from "./permission_state.js";
import {
  captureCodexPermissionRolloutCursor, codexPermissionContextAfter,
  type CodexPermissionRolloutCursor, type CodexPermissionTurnContext,
} from "./rollout.js";
import type { AppServerDispatchIdentity, AppServerTurnIdentity } from "./app_server_transport.js";

export type CodexPermissionAssessment =
  | { applied: true; observation: PermissionObservation }
  | { applied: false; observation: PermissionObservation | null;
      reason: "observation_unavailable" | "approval_policy_mismatch" | "policy_mismatch"; diagnostic?: string };

export function assessCodexPermission(submission: PermissionSubmission, context: CodexPermissionTurnContext | null): CodexPermissionAssessment {
  if (context === null) return { applied: false, observation: null, reason: "observation_unavailable" };
  const policy = context.approvalPolicy;
  const approval = policy === "never" || policy === "untrusted" || policy === "on-request" || policy === "on-failure" ? policy : null;
  const observation: PermissionObservation | null = approval === null ? null : {
    ...submission, session_id: context.sessionId, turn_id: context.turnId,
    permission: { sandbox: context.sandbox, approval, enforcement: "os" }, network_access: context.networkAccess,
  };
  if (policy !== "never" || observation === null) return {
    applied: false, observation, reason: "approval_policy_mismatch",
    diagnostic: `codex: permission policy mismatch: expected approval=never; observed approval=${policy}\n`,
  };
  const expected = submission.requested;
  const network = effectiveNetworkAccess(expected.sandbox, expected.network_access);
  if (context.sandbox !== expected.sandbox || context.networkAccess !== network) return {
    applied: false, observation, reason: "policy_mismatch",
    diagnostic: "codex: permission policy mismatch: " +
      `expected sandbox=${expected.sandbox} network_access=${network}; ` +
      `observed sandbox=${context.sandbox} network_access=${context.networkAccess}\n`,
  };
  return { applied: true, observation };
}

export class AppServerPermissionSuperseded extends Error {
  readonly reason = "permission_superseded";
  constructor() { super("App-server permission selection changed before dispatch"); }
}

export interface AppServerPermissionAttempt {
  submission: PermissionSubmission;
  cursor: CodexPermissionRolloutCursor;
  threadId: string;
  hostTurnToken: string;
}

/** Call synchronously at dispatch, after the last server permission-sync wait. */
export function captureAppServerPermission(
  root: string, state: PermissionState, selection: PermissionSelection, identity: AppServerDispatchIdentity,
  freshThread = false,
): AppServerPermissionAttempt {
  if (!canSubmitPermission(state, selection)) throw new AppServerPermissionSuperseded();
  return {
    submission: { revision: selection.revision, requested: { ...selection.requested }, execution_id: randomUUID() },
    // thread/start can return before its rollout exists; only its first dispatch
    // may use an empty baseline. A missing resume file remains untrusted.
    cursor: captureCodexPermissionRolloutCursor(root, freshThread ? null : identity.threadId),
    threadId: identity.threadId, hostTurnToken: identity.hostTurnToken,
  };
}

/** The caller applies the returned assessment without another await. A newer
 * pending selection does not retire the current execution's policy evidence. */
export async function observeAppServerPermission(
  attempt: AppServerPermissionAttempt, terminal: AppServerTurnIdentity, state: () => PermissionState,
): Promise<CodexPermissionAssessment | null> {
  if (attempt.threadId !== terminal.threadId || attempt.hostTurnToken !== terminal.hostTurnToken) return null;
  for (let retry = 0; ; retry += 1) {
    if (!isCurrentPermissionExecution(state(), attempt.submission)) return null;
    const context = codexPermissionContextAfter(attempt.cursor, terminal.threadId, terminal.turnId);
    if (context !== null || retry === 4) return assessCodexPermission(attempt.submission, context);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
