import { execFile } from "node:child_process";

export type CodexAuthMode = "chatgpt" | "apikey" | "unknown";

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
  const auth = (checks as Record<string, unknown>).auth;
  if (typeof auth !== "object" || auth === null) return "unknown";
  const credentials = (auth as Record<string, unknown>).credentials;
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
