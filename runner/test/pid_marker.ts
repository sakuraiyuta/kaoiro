import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { requirePositiveSafePid } from "@kaoiro/wrapper-core";

export interface PidMarkerFileOperations {
  writeFileSync(path: string, content: string): unknown;
  renameSync(from: string, to: string): unknown;
}

export function publishPidMarker(
  path: string,
  pid: number,
  files: PidMarkerFileOperations,
  content = String(pid),
): void {
  const temporaryPath = `${path}.tmp-${pid}`;
  files.writeFileSync(temporaryPath, content);
  files.renameSync(temporaryPath, path);
}

export function embeddedPidMarkerWriter(): string {
  return publishPidMarker.toString();
}

export type ProcessStatReader = (pid: number) => string;
export type OwnedPidSignal = (pid: number, signal: NodeJS.Signals) => unknown;
export type PositiveSafePidValidator = (value: unknown) => number;

export function signalPidIfStartMatches(
  rawPid: unknown,
  expectedStart: string,
  validatePid: PositiveSafePidValidator,
  readStat: ProcessStatReader,
  signal: OwnedPidSignal,
): boolean {
  const pid = validatePid(rawPid);
  if (pid < 2 || pid === process.pid) return false;

  let stat: string;
  try {
    stat = readStat(pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return false;
    throw error;
  }
  const observedStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (observedStart !== expectedStart) return false;

  try {
    signal(pid, "SIGTERM");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return false;
    throw error;
  }
}

export interface PidMarkerReaderOperations {
  exists(path: string): boolean;
  read(path: string): string;
}

export async function readPidMarker(
  path: string,
  timeoutMs: number,
  files: PidMarkerReaderOperations = {
    exists: existsSync,
    read: (file) => readFileSync(file, "utf8"),
  },
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => number = () => performance.now(),
): Promise<number> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (files.exists(path)) {
      const text = files.read(path).trim();
      if (text !== "") return requirePositiveSafePid(text);
    }
    await pause(Math.min(10, Math.max(0, deadline - now())));
  }
  throw new Error(`timed out waiting for a non-empty PID marker: ${path}`);
}
