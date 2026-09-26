import { spawn } from "node:child_process";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { boundErrorDetail } from "@kaoiro/agent-common";

export const DEFAULT_CHILD_KILL_DEADLINE_MS = 4_000;
const STDERR_TAIL_CHARS = 2_048;

interface BoundedSpawnOptions {
  hostAbort: AbortSignal;
  deadlineMs: number | null;
  spawnOverride?: (options: SpawnOptions) => SpawnedProcess;
  stderr?: (text: string) => void;
  warn: (message: string) => void;
}

/** Own the SDK's direct CLI child so a wrapper reset cannot interrupt its
 * seven-second SIGKILL escalation at the runner's five-second boundary. */
export function spawnBoundedClaudeProcess(
  options: SpawnOptions,
  binding: BoundedSpawnOptions,
): SpawnedProcess {
  const child = binding.spawnOverride
    ? binding.spawnOverride(options)
    : spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

  if (!binding.spawnOverride) {
    // The SDK's default spawner owns stderr; its custom-spawn path does not.
    // Drain here so a chatty CLI cannot block its own stdout/exit on a full pipe.
    const stderr = (child as ReturnType<typeof spawn>).stderr;
    const decoder = new TextDecoder();
    let tail = "";
    stderr?.on("data", (chunk: Buffer) => {
      const text = decoder.decode(chunk, { stream: true });
      tail = (tail + text).slice(-STDERR_TAIL_CHARS);
      binding.stderr?.(text);
    });
    stderr?.once("end", () => {
      tail = (tail + decoder.decode()).slice(-STDERR_TAIL_CHARS);
    });
    child.once("exit", (code, signal) => {
      if (!binding.hostAbort.aborted && code !== 0 && tail !== "") {
        binding.warn(
          boundErrorDetail(`[kaoiro] Claude CLI exited (${code ?? signal ?? "unknown"}); stderr tail: ${tail}`),
        );
      }
    });
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const armDeadline = (): void => {
    if (timer !== null || binding.deadlineMs === null) return;
    if (child.exitCode !== null || child.signalCode != null) return;
    timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
    }, binding.deadlineMs);
    // Intentionally keep this timer ref'ed: the SDK's own timers are unref'ed,
    // so an otherwise idle wrapper could exit while its CLI child is alive.
  };
  binding.hostAbort.addEventListener("abort", armDeadline, { once: true });
  if (binding.hostAbort.aborted) armDeadline();
  child.once("exit", () => {
    if (timer !== null) clearTimeout(timer);
    binding.hostAbort.removeEventListener("abort", armDeadline);
  });
  return child;
}
