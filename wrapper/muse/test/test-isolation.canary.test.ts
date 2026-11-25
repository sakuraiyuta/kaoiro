import { it } from "vitest";
import {
  assertIsolationActive,
} from "../../../scripts/test/fixtures/test-isolation-canary.mjs";

// Module scope as well: scripts/test-isolation/check.mjs lists this package's
// suite with `vitest list`, which collects files without running tests.
await assertIsolationActive();

// docs/contributing/test-isolation.md: red when this package's setup stops
// loading the isolation module.
it("runs under the test isolation guard", async () => {
  await assertIsolationActive();
});
