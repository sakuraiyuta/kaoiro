import {
  notification,
  safeName,
  type AcpExtension,
  type WireMetadata,
} from "../acp/connection.js";

export const GROK_SESSION_NOTIFICATION = "_x.ai/session_notification";
export const GROK_QUEUE_CHANGED = "_x.ai/queue/changed";

export interface GrokWireMetadata extends WireMetadata {
  vendor_kind?: string;
  prompt_id?: string;
  request_id?: string;
  hook_event?: string;
  /** Lines a loading generation could not hold before its promotion. */
  loading_lines_dropped?: number;
}

interface RawLine {
  method?: string;
  params?: {
    notification?: { type?: unknown; event?: unknown; hook_event?: unknown };
    update?: {
      sessionUpdate?: unknown;
      event_name?: unknown;
      prompt_id?: unknown;
    };
  };
  result?: { _meta?: { promptId?: unknown; requestId?: unknown } };
}

/**
 * Grok's identifiers on one wire line. The expressions are the ones the ACP
 * tee used before the extraction: a non-string `method` throws here, and the
 * tee then drops that line's metadata exactly as it did.
 */
export function grokWireFields(
  message: Record<string, unknown>,
): Partial<Omit<GrokWireMetadata, keyof WireMetadata>> {
  const msg = message as RawLine;
  const note = msg.params?.notification;
  const update = msg.params?.update;
  const vendorKind = msg.method?.startsWith("_x.ai/")
    ? (update?.sessionUpdate ?? note?.type)
    : undefined;
  const hookEvent = update?.event_name ?? note?.event ?? note?.hook_event;
  const promptId = msg.result?._meta?.promptId ?? update?.prompt_id;
  return {
    ...(safeName(vendorKind) ? { vendor_kind: safeName(vendorKind)! } : {}),
    ...(safeName(promptId) ? { prompt_id: safeName(promptId)! } : {}),
    ...(safeName(msg.result?._meta?.requestId)
      ? { request_id: safeName(msg.result?._meta?.requestId)! }
      : {}),
    ...(safeName(hookEvent) ? { hook_event: safeName(hookEvent)! } : {}),
  };
}

/** The `session/new` `_meta` that injects persona and footer rules. */
export function grokSessionMeta(rules: string): Record<string, unknown> {
  return { rules };
}

export function grokExtension(
  onSessionNotification: (notification: Record<string, unknown>) => void,
  onQueueChanged: (params: Record<string, unknown>) => void = () => {},
): AcpExtension<GrokWireMetadata> {
  return {
    notifications: [
      notification(
        GROK_SESSION_NOTIFICATION,
        (params) => params as Record<string, unknown>,
        onSessionNotification,
      ),
      notification(
        GROK_QUEUE_CHANGED,
        (params) => params as Record<string, unknown>,
        onQueueChanged,
      ),
    ],
    wireFields: grokWireFields,
  };
}
