import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";

it("records whether a nested Vitest invocation reached a test body", () => {
  if (process.env.FUJI464_SENTINEL) writeFileSync(process.env.FUJI464_SENTINEL, "ran");
  expect(true).toBe(true);
});
