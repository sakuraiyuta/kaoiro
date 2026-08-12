// Type declaration for build-identity.mjs (issue #228 round 2 MF-2/MF-5).
// This repo-level script has no compiler config of its own — it's plain
// Node ESM, imported at build time by runner/scripts/generate-build-info.mjs
// (untyped, not part of any tsconfig `include`) and by runner's test suite
// (typed, since runner/tsconfig.json's `include` covers `test/`). This
// sibling `.d.mts` is TS's standard way to type a plain `.mjs` module
// without `allowJs`.

export interface BuildIdentity {
  revision: string;
  dirty: boolean;
  degraded: boolean;
  degradeReason: string | null;
}

export function computeBuildIdentity(cwd?: string): BuildIdentity;

export function formatIdentityString(identity: {
  revision: string;
  dirty: boolean;
}): string;

export function isValidBuildInfoShape(value: unknown): value is {
  revision: string;
  dirty: boolean;
};
