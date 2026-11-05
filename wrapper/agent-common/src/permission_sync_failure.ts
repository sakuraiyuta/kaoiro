import { writeRedactedStderr } from "@kaoiro/wrapper-core";
import type { Envelope, ResultPayload } from "@kaoiro/protocol";

export function permissionSyncFailure(recoveryAttempt = false): ResultPayload {
  const detail = recoveryAttempt
    ? "Permission synchronization timed out before recovery execution. The earlier attempt may have executed. Check the connection before deciding whether to resend. No automatic resend occurs."
    : "Permission synchronization timed out before input dispatch. No execution was started for this input. Check the wrapper connection and rejected-sync diagnostic; after synchronization recovers, resend the input. No automatic resend occurs.";
  writeRedactedStderr(`${detail}\n`);
  return { text: "", is_error: true, error_subtype: "error_during_execution", error_detail: detail };
}

export function retirePermissionSyncInput(options: {
  envelopes: readonly Envelope[];
  retire: (envelopes: readonly Envelope[]) => boolean | undefined;
  forgetStages?: (envelopes: readonly Envelope[]) => void;
  clearInjection: () => void;
}): void {
  if (options.envelopes.length > 0 && options.retire(options.envelopes) !== true) {
    writeRedactedStderr("permission_sync_timeout: delivery retirement unavailable\n");
  }
  options.forgetStages?.(options.envelopes);
  options.clearInjection();
}
