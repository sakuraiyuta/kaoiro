import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { isValidBuildVersion, isValidBuildBranch } from "../src/build_identity_domain.js";
const fixture = JSON.parse(readFileSync(new URL("../../../scripts/fixtures/build-identity-domain.json", import.meta.url), "utf8"));
it.each((fixture.valid_versions as unknown[]))("accepts version %s", (v) => expect(isValidBuildVersion(v)).toBe(true));
it.each((fixture.invalid_versions as unknown[]))("rejects version %s", (v) => expect(isValidBuildVersion(v)).toBe(false));
it.each((fixture.valid_branches as unknown[]))("accepts branch %s", (v) => expect(isValidBuildBranch(v)).toBe(true));
it.each((fixture.invalid_branches as unknown[]))("rejects branch %s", (v) => expect(isValidBuildBranch(v)).toBe(false));
