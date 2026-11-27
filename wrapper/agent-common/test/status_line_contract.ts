import "../../../scripts/test/fixtures/test-isolation.mjs";
import { expect, it, type Mock } from "vitest";
import type { ToolDescriptor } from "../src/index.js";

export function testStatusLineContract(
  compose: () => Promise<{
    descriptors: ToolDescriptor[];
    setStatusLine: Mock;
    readStatusLine: Mock;
  }>,
): void {
  it("offers both status line tools", async () => {
    const { descriptors } = await compose();
    expect(descriptors.map((d) => d.name)).toEqual(
      expect.arrayContaining(["set_status_line", "read_status_line"]),
    );
  });

  it("sets the status line on the first call", async () => {
    const { descriptors, setStatusLine } = await compose();
    const result = await descriptors.find((d) => d.name === "set_status_line")!
      .handler({ text: "hello" });
    expect(setStatusLine).toHaveBeenNthCalledWith(1, "hello");
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      status_line: {
        bytes: 5, truncated: false, updated_at: "2026-10-03T12:00:00.000001Z",
      },
    });
  });

  it("reads the status line for the requested agent", async () => {
    const { descriptors, readStatusLine } = await compose();
    const result = await descriptors.find((d) => d.name === "read_status_line")!
      .handler({ agent_id: "peer.1" });
    expect(readStatusLine).toHaveBeenNthCalledWith(1, "peer.1");
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      agent_id: "peer.1", status_line: { text: "peer text" },
    });
  });
}
