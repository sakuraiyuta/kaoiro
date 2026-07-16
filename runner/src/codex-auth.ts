import { execFile } from "node:child_process";
import type { CodexAuthMode as CatalogAuthMode } from "@kaoiro/codex";
import type { CodexConfig } from "./config.js";

export type CodexAuthMode = CatalogAuthMode;

interface DoctorResult {
  stdout: string;
}

type RunDoctor = () => Promise<DoctorResult>;

function runCodexDoctor(): Promise<DoctorResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "codex",
      ["doctor", "--json", "--no-color"],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 10_000,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({ stdout });
      },
    );
  });
}

export function parseCodexAuthMode(value: unknown): CodexAuthMode {
  if (typeof value !== "object" || value === null) return "unknown";
  const checks = (value as Record<string, unknown>).checks;
  if (typeof checks !== "object" || checks === null) return "unknown";
  // codex 0.144.1 の doctor JSON では checks の要素キーは "auth.credentials"
  // のようなリテラルなドット付き文字列で、ネストしたパスではない。
  const credentials =
    (checks as Record<string, unknown>)["auth.credentials"];
  if (typeof credentials !== "object" || credentials === null) {
    return "unknown";
  }
  const details = (credentials as Record<string, unknown>).details;
  if (typeof details !== "object" || details === null) return "unknown";
  const mode = (details as Record<string, unknown>)["stored auth mode"];
  return mode === "chatgpt" || mode === "apikey" ? mode : "unknown";
}

export async function detectCodexAuthMode(
  runDoctor: RunDoctor = runCodexDoctor,
): Promise<CodexAuthMode> {
  let stdout: string;
  try {
    ({ stdout } = await runDoctor());
  } catch {
    process.stderr.write(
      "runner: warn — Codex auth mode detection failed; " +
        "model catalog will be empty\n",
    );
    return "unknown";
  }

  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    process.stderr.write(
      "runner: warn — Codex doctor returned invalid JSON; " +
        "model catalog will be empty\n",
    );
    return "unknown";
  }

  const mode = parseCodexAuthMode(report);
  if (mode === "unknown") {
    process.stderr.write(
      "runner: warn — Codex doctor did not report a supported auth mode; " +
        "model catalog will be empty\n",
    );
  }
  return mode;
}

/** Startup / hot-reload resolver for Codex auth mode (Phase-24). Injectable
 *  policy resolver: the priority policy is encoded as a pure function of
 *  its `AuthModeResolveInput`, but the default `detect` binding calls the
 *  real `detectCodexAuthMode` which spawns the codex doctor CLI (I/O). Tests
 *  inject a mock `detect` so CLI startup / `applyReload` branches can be
 *  pinned without spawning doctor. Priority:
 *
 *  1. Codex disabled (`nextEnabled === false`) → `"unknown"` (doctor is
 *     never invoked, whatever `prevMode` was is discarded).
 *  2. `codex.auth_mode` set → return the declared value verbatim (doctor
 *     is NEVER invoked in this branch — this is the exact invariant that
 *     survives a runner PATH with no `codex` binary).
 *  3. On the *transition* explicit → absent, or off → on with no explicit
 *     auth_mode, re-run the injectable `detect` fn. This keeps the CLI
 *     agnostic of the doctor implementation.
 *  4. In steady state (both prev and next `enabled` with no explicit
 *     `auth_mode` in either), preserve `prevMode`.
 *
 *  `prevCodex` / `prevEnabled` / `prevMode` are undefined on startup so the
 *  startup branch collapses onto rules 1-3. Explicit inference from
 *  `chatgpt_plan` is forbidden (an API-key runner may have a `chatgpt_plan`
 *  set for a different reason; auto-inferring auth mode would misclassify). */
export interface AuthModeResolveInput {
  nextCodex: CodexConfig | undefined;
  nextEnabled: boolean;
  prevCodex?: CodexConfig | undefined;
  prevEnabled?: boolean;
  prevMode?: CodexAuthMode;
  detect?: () => Promise<CodexAuthMode>;
}

export async function resolveCodexAuthMode(
  input: AuthModeResolveInput,
): Promise<CodexAuthMode> {
  const detect = input.detect ?? detectCodexAuthMode;
  if (!input.nextEnabled) return "unknown";
  const explicit = input.nextCodex?.auth_mode;
  if (explicit !== undefined) return explicit;
  const prevExplicit = input.prevCodex?.auth_mode;
  // Startup (prevEnabled undefined) OR off → on transition: run doctor once.
  if (input.prevEnabled === undefined || input.prevEnabled === false) {
    return await detect();
  }
  // explicit → absent transition: re-detect (operator dropped the pin).
  if (prevExplicit !== undefined) return await detect();
  // Steady state (both sides enabled + no explicit either side): preserve.
  return input.prevMode ?? "unknown";
}
