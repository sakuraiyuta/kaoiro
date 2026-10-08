import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { requirePositiveSafePid } from "../src/pid.js";

export interface PidMarkerFileOperations {
  writeFileSync(path: string, content: string): unknown;
  renameSync(from: string, to: string): unknown;
}

export function publishPidMarker(
  path: string,
  pid: number,
  files: PidMarkerFileOperations,
): void {
  const temporaryPath = `${path}.tmp-${pid}`;
  files.writeFileSync(temporaryPath, String(pid));
  files.renameSync(temporaryPath, path);
}

export function embeddedPidMarkerWriter(): string {
  return publishPidMarker.toString();
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
