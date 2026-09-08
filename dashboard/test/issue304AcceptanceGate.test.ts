import { describe, expect, it } from "vitest";

// @ts-expect-error benchmark verifier is executable JavaScript, not a package API.
import { validateIssue304Acceptance } from "../bench/issue304Acceptance.mjs";

function records(longtaskCounts: readonly number[]) {
  return ["ascii", "ime"].flatMap((mode) =>
    ["h1000-expanded", "h5000-tail", "h1000-tail"].flatMap((scenario) =>
      longtaskCounts.map((count, run) => ({
        variant: "after",
        scenario,
        mode,
        run,
        primary: { dispatchToInput: { p95: 10 } },
        longTasks: Array.from({ length: count }),
      })),
    ),
  );
}

describe("issue #304 Version 2 longtask median gate", () => {
  it("allows one longtask in one of three runs", () => {
    expect(() => validateIssue304Acceptance(records([1, 0, 0]))).not.toThrow();
  });

  it("rejects a nonzero longtask median", () => {
    expect(() => validateIssue304Acceptance(records([1, 1, 0]))).toThrow(
      "longtask median acceptance failure",
    );
  });
});
