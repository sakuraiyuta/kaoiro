import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it, vi } from "vitest";
import { workToolDescriptors, type WorkToolHandlers } from "../src/work_tools.js";

const workStatus = vi.fn(async () => ({ work: null }));
const handlers = {
  workControlSupported: () => true,
  deliveryModesSupported: () => true,
  deliveryModes: () => "legacy" as const,
  workStatus,
  workOpResult: vi.fn(async () => ({ status: "unknown_operation" })),
  deliveryStatus: vi.fn(async () => ({ status: "expired" as const })),
} as unknown as WorkToolHandlers;

describe("work tool descriptors", () => {
  it("exposes all five tools, rejects malformed arguments before transport, and invokes valid requests", async () => {
    const descriptors = workToolDescriptors(handlers);
    expect(descriptors.map(tool => tool.name)).toEqual([
      "work_status", "work_op_result", "delivery_status",
    ]);
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

});
