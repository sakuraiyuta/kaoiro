// Compile-negative pins for SetPermissionRequest (issue #359 S1). tsc --noEmit
// (strict + exactOptionalPropertyTypes) checks this file via `include: ["src"]`;
// it is not part of the package's exported surface. Each @ts-expect-error must
// stay USED: if a future edit lets an axis-less request type-check again, the
// suppression becomes unused and `pnpm typecheck` fails, catching the regression.
import type { SetPermissionRequest } from "./index.js";

// @ts-expect-error — approval: undefined erases the only axis at JSON time, so
// the required-approval arm must reject undefined (NonNullable).
const _undefinedApproval: SetPermissionRequest = {
  version: "0",
  agent_id: "a",
  approval: undefined,
};

// @ts-expect-error — no mutable axis at all is not a valid request.
const _noAxis: SetPermissionRequest = { version: "0", agent_id: "a" };

// Positive control: a real approval axis must still type-check.
const _validApproval: SetPermissionRequest = {
  version: "0",
  agent_id: "a",
  approval: "never",
};

void _undefinedApproval;
void _noAxis;
void _validApproval;
