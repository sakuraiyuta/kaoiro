// Type declaration for build-identity.mjs (issue #218 round 2 MF-2/MF-5).
// This repo-level script has no compiler config of its own — it's plain
// Node ESM, imported at build time by runner/scripts/generate-build-info.mjs
// (untyped, not part of any tsconfig `include`) and by runner's test suite
// (typed, since runner/tsconfig.json's `include` covers `test/`). This
// sibling `.d.mts` is TS's standard way to type a plain `.mjs` module
// without `allowJs`.

export interface BuildIdentity {
  revision: string;
  dirty: boolean;
  version: string;
  channel: "dev" | "release";
  branch: string;
  landing?: LandingRecord;
  degraded: boolean;
  degradeReason: string | null;
}

export interface LandingRecord {
  schema: 1;
  kind: "landing";
  repository_id: number;
  revision: string;
  branch: "develop";
  version: string;
  original_run_id: number;
  created_at: string;
}
export interface FrozenBuildIdentity {
  revision: string;
  dirty: boolean;
  version: string;
  channel: "dev" | "release";
  branch: string;
  built_at: string;
  build_identity_formats: string[];
  landing?: LandingRecord;
}
export interface IdentityOptions {
  buildRef?: string;
  repositoryId?: number;
  target?: string;
  timeoutMs?: number;
}
export const BUILD_REPOSITORY_ID: number;
export const BUILD_IDENTITY_FORMATS: string[];
export function computeBuildIdentity(cwd?: string, options?: IdentityOptions): BuildIdentity;
export function requireTaggedIdentity(cwd?: string, options?: IdentityOptions): BuildIdentity;
export function isValidBuildBranch(value: unknown): value is string;
export function parseLandingVersion(value: unknown): { day: string; number: number } | null;
export function formatLandingVersion(day: string, number: number): string;
export function validateLandingRecord(value: unknown, repositoryId?: number): LandingRecord;
export function readLandingTag(cwd: string, tag: string, repositoryId?: number): { record: LandingRecord; object: string; tag: string };
export function artifactBuildIdentity(identity: BuildIdentity, builtAt?: string): FrozenBuildIdentity;
export function readFrozenBuildIdentity(file: string, expectedDigest?: string): FrozenBuildIdentity;
export function consumeBuildIdentity(cwd?: string, env?: Record<string, string | undefined>): FrozenBuildIdentity;

export function formatIdentityString(identity: {
  revision: string;
  dirty: boolean;
}): string;

export function isValidBuildInfoShape(value: unknown): value is {
  revision: string;
  dirty: boolean;
};

export function validateFrozenBuildIdentity(value: unknown): FrozenBuildIdentity;
export function explicitBuildIdentity(env: Record<string, string | undefined>): FrozenBuildIdentity | null;
export function assertSourceIdentity(cwd: string, identity: FrozenBuildIdentity): void;
