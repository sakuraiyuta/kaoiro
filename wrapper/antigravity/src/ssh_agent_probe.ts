import { execFile as nodeExecFile } from "node:child_process";

export const SSH_AGENT_PROBE_TIMEOUT_MS = 3_000;

/** Verbatim `ssh-add -l` output for an empty agent (measured, OpenSSH 9.x
 *  under `LC_ALL=C`; exit status 1). A missing socket exits 2 with a
 *  different message and is deliberately NOT classified. */
const NO_IDENTITIES_TEXT = "The agent has no identities.";

export type SshAgentIdentities = "no_identities" | "unknown";

export interface SshAgentProbeOptions {
  env: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  execFile?: typeof nodeExecFile;
}

/**
 * Bounded launch-time probe of the inherited `SSH_AUTH_SOCK`. Resolves
 * `"no_identities"` only on the exact measured shape (exit 1 + the fixed
 * sentence); a missing `ssh-add`, a dead socket, a timeout, or any other
 * exit is `"unknown"` so an unproven state never turns into a warning.
 */
export function probeSshAgentIdentities(
  options: SshAgentProbeOptions,
): Promise<SshAgentIdentities> {
  const socket = options.env.SSH_AUTH_SOCK;
  if (socket === undefined || socket === "") return Promise.resolve("unknown");
  const execFile = options.execFile ?? nodeExecFile;
  return new Promise((resolve) => {
    try {
      execFile(
        "ssh-add",
        ["-l"],
        {
          env: { ...options.env, LC_ALL: "C" },
          timeout: options.timeoutMs ?? SSH_AGENT_PROBE_TIMEOUT_MS,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          const exitCode = (error as { code?: unknown } | null)?.code;
          resolve(
            exitCode === 1 && `${stdout}${stderr}`.includes(NO_IDENTITIES_TEXT)
              ? "no_identities"
              : "unknown",
          );
        },
      );
    } catch {
      resolve("unknown");
    }
  });
}
