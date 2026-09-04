import type { AdapterEvent, LogEntry, ResultPayload } from "@kaoiro/agent-common";

export type AgyStreamEvent =
  | {
      event: "init";
      conversation_id: string;
      init: {
        cwd?: string;
        model?: string;
        permission_mode?: string;
        tools?: unknown;
      };
    }
  | {
      event: "step_update";
      step_update: {
        conversation_id?: string;
        step_index?: number;
        state?: string;
        step_type?: string;
        text_delta?: string;
        tool_name?: string;
        tool_info?: {
          name?: string;
          parameters?: unknown;
          output?: unknown;
          error?: { message?: unknown };
        };
      };
    }
  | {
      event: "result";
      result: {
        conversation_id?: string;
        status?: string;
        response?: unknown;
        error?: unknown;
      };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgyStreamEvent(value: unknown): value is AgyStreamEvent {
  if (!isRecord(value) || typeof value.event !== "string") return false;
  switch (value.event) {
    case "init":
      return typeof value.conversation_id === "string" && isRecord(value.init);
    case "step_update":
      return isRecord(value.step_update);
    case "result":
      return isRecord(value.result);
    default:
      return false;
  }
}

/** Parses one `agy --output-format stream-json` line. Malformed and unknown
 * lines are ignored so one vendor-side diagnostic cannot end a turn. */
export function parseAgyStreamLine(line: string): AgyStreamEvent | null {
  try {
    const value: unknown = JSON.parse(line);
    return isAgyStreamEvent(value) ? value : null;
  } catch {
    return null;
  }
}

function toolUseId(event: Extract<AgyStreamEvent, { event: "step_update" }>): string | null {
  const { conversation_id, step_index, step_type } = event.step_update;
  return step_type === "tool" && typeof conversation_id === "string" && typeof step_index === "number"
    ? `agy:${conversation_id}:${step_index}`
    : null;
}

function toolInput(event: Extract<AgyStreamEvent, { event: "step_update" }>): Record<string, unknown> {
  const input = event.step_update.tool_info?.parameters;
  return isRecord(input) ? input : {};
}

/** Translates a parsed stream-json event into coarse state-machine input. */
export function agyEventToEvents(event: AgyStreamEvent): AdapterEvent[] {
  if (event.event === "init") return [{ kind: "session_init" }];
  if (event.event === "result") {
    return [
      {
        kind: "result",
        subtype:
          event.result.status === "SUCCESS" || event.result.status === "CANCELED"
            ? "success"
            : "error_during_execution",
      },
    ];
  }

  const step = event.step_update;
  if (step.step_type === "agent_response") {
    return [
      {
        kind: "assistant",
        blocks: typeof step.text_delta === "string" ? ["text"] : ["thinking"],
      },
    ];
  }
  if (step.step_type !== "tool") return [];

  const id = toolUseId(event);
  if (step.state === "ACTIVE") {
    return [
      id === null
        ? { kind: "assistant", blocks: ["tool_use"] }
        : { kind: "assistant", blocks: ["tool_use"], toolUseIds: [id] },
    ];
  }
  if (step.state === "DONE" || step.state === "ERROR") {
    return [id === null ? { kind: "tool_result" } : { kind: "tool_result", toolUseIds: [id] }];
  }
  return [];
}

/** Extracts relayable assistant and tool records from one stream event. */
export function agyEventToLogs(event: AgyStreamEvent): LogEntry[] {
  if (event.event !== "step_update") return [];
  const step = event.step_update;
  if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
    return [{ kind: "assistant", text: step.text_delta }];
  }
  if (step.step_type !== "tool") return [];

  const id = toolUseId(event) ?? undefined;
  if (step.state === "ACTIVE") {
    const toolName = step.tool_name ?? step.tool_info?.name;
    return typeof toolName === "string"
      ? [
          {
            kind: "tool_use",
            ...(id === undefined ? {} : { tool_use_id: id }),
            tool_name: toolName,
            input: toolInput(event),
          },
        ]
      : [];
  }
  if (step.state === "DONE" || step.state === "ERROR") {
    const output =
      step.state === "ERROR"
        ? step.tool_info?.error?.message
        : step.tool_info?.output;
    return [
      {
        kind: "tool_result",
        ...(id === undefined ? {} : { tool_use_id: id }),
        output: typeof output === "string" ? output : "",
      },
    ];
  }
  return [];
}

/** Conversation id carried by init. The host preserves it for `--conversation`. */
export function agyEventToSessionId(event: AgyStreamEvent): string | null {
  return event.event === "init" ? event.conversation_id : null;
}

/** Final result payload; `CANCELED` is a normal completed turn per the probe. */
export function agyEventToResult(event: AgyStreamEvent): ResultPayload | null {
  if (event.event !== "result") return null;
  if (event.result.status === "SUCCESS" || event.result.status === "CANCELED") {
    return typeof event.result.response === "string" ? { text: event.result.response } : {};
  }
  return {
    is_error: true,
    error_subtype: "error_during_execution",
    ...(typeof event.result.error === "string" ? { error_detail: event.result.error } : {}),
  };
}

export function agyEventToErrorDetail(event: AgyStreamEvent): string | null {
  return event.event === "result" && event.result.status === "ERROR" && typeof event.result.error === "string"
    ? event.result.error
    : null;
}
