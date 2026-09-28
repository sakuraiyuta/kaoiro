import { describe, expect, it, vi } from "vitest";
import { workToolDescriptors, type WorkToolHandlers } from "../src/work_tools.js";

const workStatus = vi.fn(async () => ({ work: null }));
const workCheck = vi.fn(async () => ({ ok: true }));
const handlers = {
  workControlSupported: () => true,
  deliveryModesSupported: () => true,
  deliveryModes: () => "legacy" as const,
  workStatus,
  workCheck,
  workTransferAck: vi.fn(async () => ({ ok: true })),
  workOpResult: vi.fn(async () => ({ status: "unknown_operation" })),
  deliveryStatus: vi.fn(async () => ({ status: "expired" as const })),
} as unknown as WorkToolHandlers;

describe("work tool descriptors", () => {
  it("exposes all five tools, rejects malformed arguments before transport, and invokes valid requests", async () => {
    const descriptors = workToolDescriptors(handlers);
    expect(descriptors.map(tool => tool.name)).toEqual([
      "work_status", "work_check", "work_transfer_ack", "work_op_result", "delivery_status",
    ]);
    const check = descriptors.find(tool => tool.name === "work_check")!;
    expect((await check.handler({ work_id: "w", action: "land", expected_revision: -1 })).isError).toBe(true);
    expect(workCheck).not.toHaveBeenCalled();
    expect((await check.handler({ work_id: "w", action: "land", expected_revision: 3 })).isError).toBeUndefined();
    expect(workCheck).toHaveBeenCalledWith({ work_id: "w", action: "land", expected_revision: 3 });
    const status = descriptors.find(tool => tool.name === "delivery_status")!;
    expect((await status.handler({ conversation_id: "c" })).isError).toBe(true);
  });

  it("returns a local fail-closed result when work control was not negotiated", async () => {
    const [tool] = workToolDescriptors({ ...handlers, workControlSupported: () => false });
    const result = await tool!.handler({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: "work_control_unavailable", send_not_attempted: true });
    expect(workStatus).not.toHaveBeenCalled();
  });

  it("projects work_transfer_ack to its restricted result shape", async () => {
    const descriptors = workToolDescriptors({
      ...handlers,
      workTransferAck: async () => ({
        work_id: "w",
        transfer_id: "t",
        state: "acknowledged",
        work: { secret: "not for the former assignee" },
      } as never),
    });
    const tool = descriptors.find(candidate => candidate.name === "work_transfer_ack")!;
    const result = await tool.handler({ work_id: "w", transfer_id: "t" });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      work_id: "w",
      transfer_id: "t",
      state: "acknowledged",
    });
  });
});
