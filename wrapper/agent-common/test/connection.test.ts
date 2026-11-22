import "../../../scripts/test/fixtures/test-isolation.mjs";
import { expect, it } from "vitest";
import { metadataTee, type WireMetadata } from "../src/acp/connection.js";

async function pass(
  chunks: Uint8Array[], observer?: () => void,
) {
  const metadata: WireMetadata[] = [];
  const tee = metadataTee("in", (m) => {
    metadata.push(m); observer?.();
  });
  const reader = tee.readable.getReader();
  const writer = tee.writable.getWriter();
  const received: Uint8Array[] = [];
  const read = (async () => {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      received.push(result.value);
    }
  })();
  const write = (async () => {
    for (const chunk of chunks) await writer.write(chunk);
    await writer.close();
  })();
  await Promise.all([read, write]);
  expect(Buffer.concat(received).equals(Buffer.concat(chunks))).toBe(true);
  return metadata;
}
it("passes oversized fragmented lines with bounded metadata", async () => {
  const bytes = Buffer.from(JSON.stringify({ method: "large",
    body: "OVERSIZE_BODY_MARKER" + "ø".repeat(3 * 1024 * 1024),
  }) + "\n" + JSON.stringify({ method: "normal" }) + "\n");
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += 511_111)
    chunks.push(bytes.subarray(offset, offset + 511_111));
  expect(await pass(chunks)).toEqual([
    { direction: "in", oversized_lines: 1 },
    { direction: "in", method: "normal" },
  ]);
});
it("limits each line rather than the combined chunk", async () => {
  const line = JSON.stringify({ method: "normal", body: "x".repeat(2000) });
  const metadata = await pass([Buffer.from((line + "\n").repeat(2500))]);
  expect(metadata).toHaveLength(2500);
  expect(metadata.every((m) => m.method === "normal")).toBe(true);
});

it("keeps diagnostic observer errors off the transport", async () => {
  const bytes = Buffer.from(
    JSON.stringify({ body: "x".repeat(5 * 1024 * 1024) }) + "\n",
  );
  expect(await pass([bytes], () => { throw new Error("observer failed"); }))
    .toEqual([{ direction: "in", oversized_lines: 1 }]);
});
