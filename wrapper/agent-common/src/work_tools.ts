import { z } from "zod";
import type {
  DeliveryStatusResult,
  DeliveryModes,
  WorkCheckResult,
  WorkOpResult,
  WorkStatusResult,
} from "@kaoiro/protocol";
import type { ToolDescriptor, ToolResult } from "./tooling.js";

const WORK_ID = z.string().min(1).max(128);

export interface WorkToolHandlers {
  workControlSupported: () => boolean;
  deliveryModesSupported: () => boolean;
  deliveryModes: () => DeliveryModes | "legacy" | "pending";
  workStatus: (input: { work_id?: string | undefined }) => Promise<WorkStatusResult>;
  workCheck: (input: { work_id: string; action: "start" | "land"; expected_revision: number; subject_hash?: string | undefined }) => Promise<WorkCheckResult>;
  workTransferAck: (input: { work_id: string; transfer_id: string }) => Promise<Record<string, unknown>>;
  workOpResult: (input: { operation_id: string }) => Promise<WorkOpResult>;
  deliveryStatus: (input: { conversation_id?: string | undefined; turn_number?: number | undefined }) => Promise<DeliveryStatusResult>;
}

const WORK_STATUS_SCHEMA = z.object({ work_id: WORK_ID.optional() }).strict();
const WORK_CHECK_SCHEMA = z.object({
  work_id: WORK_ID,
  action: z.enum(["start", "land"]),
  expected_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  subject_hash: z.string().min(1).max(256).optional(),
}).strict();
const WORK_TRANSFER_ACK_SCHEMA = z.object({ work_id: WORK_ID, transfer_id: z.string().min(1).max(128) }).strict();
const WORK_OP_RESULT_SCHEMA = z.object({ operation_id: z.string().min(1).max(128) }).strict();
const DELIVERY_STATUS_SCHEMA = z.object({
  conversation_id: z.string().min(1).max(256).optional(),
  turn_number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().refine(value => (value.conversation_id === undefined) === (value.turn_number === undefined), {
  message: "conversation_id and turn_number must be supplied together",
});

function result(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function unavailable(): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({
      error: "work_control_unavailable",
      send_not_attempted: true,
      guidance: "The server did not negotiate this control. No request was sent.",
    }) }],
  };
}

function invalid(name: string, error: z.ZodError): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${name} failed: invalid input: ${error.message}` }],
  };
}

async function run<T>(name: string, input: unknown, schema: z.ZodType<T>, available: () => boolean, handler: (value: T) => Promise<unknown>): Promise<ToolResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return invalid(name, parsed.error);
  if (!available()) return unavailable();
  try {
    return result(await handler(parsed.data));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text", text: `${name} failed: ${detail}` }] };
  }
}

export function workToolDescriptors(handlers: WorkToolHandlers): ToolDescriptor[] {
  const workAvailable = handlers.workControlSupported;
  return [
    {
      name: "work_status",
      description: "Read a work record by work_id, or list your non-terminal works when called without arguments.",
      inputSchema: z.toJSONSchema(WORK_STATUS_SCHEMA, { io: "input" }),
      handler: input => run("work_status", input, WORK_STATUS_SCHEMA, workAvailable, handlers.workStatus),
    },
    {
      name: "work_check",
      description: "Check whether a work may start or land at the expected revision. This is a cooperative check, not a lock.",
      inputSchema: z.toJSONSchema(WORK_CHECK_SCHEMA, { io: "input" }),
      handler: input => run("work_check", input, WORK_CHECK_SCHEMA, workAvailable, handlers.workCheck),
    },
    {
      name: "work_transfer_ack",
      description: "Acknowledge the specified pending transfer as its former assignee.",
      inputSchema: z.toJSONSchema(WORK_TRANSFER_ACK_SCHEMA, { io: "input" }),
      handler: input => run("work_transfer_ack", input, WORK_TRANSFER_ACK_SCHEMA, workAvailable, handlers.workTransferAck),
    },
    {
      name: "work_op_result",
      description: "Look up the receipt for a work operation by operation_id.",
      inputSchema: z.toJSONSchema(WORK_OP_RESULT_SCHEMA, { io: "input" }),
      handler: input => run("work_op_result", input, WORK_OP_RESULT_SCHEMA, workAvailable, handlers.workOpResult),
    },
    {
      name: "delivery_status",
      description: "Read stages for a message you sent. Supply both conversation_id and turn_number, or neither.",
      inputSchema: z.toJSONSchema(DELIVERY_STATUS_SCHEMA, { io: "input" }),
      handler: input => run("delivery_status", input, DELIVERY_STATUS_SCHEMA, handlers.deliveryModesSupported, handlers.deliveryStatus),
    },
  ];
}
