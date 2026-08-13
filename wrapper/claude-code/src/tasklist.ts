// Claude Code's current tasklist is persisted one task per JSON file. The
// Agent SDK stream carries the task tool_use trigger but not a whole-list
// snapshot, so the host reads this local source and keeps the wire contract
// in ADR-0049 as a last-write-wins list replacement.

import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TasklistSourceItem } from "@kaoiro/agent-common";

/** Tasklist data ready for AgentHost's common envelope normalizer. A malformed
 * source is explicit so a previously displayed list is never silently passed
 * off as current. */
export type TasklistReadResult =
  | { kind: "updated"; items: TasklistSourceItem[] }
  | { kind: "invalid"; reason: string };

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const TASK_STATUSES = new Set(["pending", "in_progress", "completed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function taskFileOrder(left: string, right: string): number {
  const leftId = left.slice(0, -".json".length);
  const rightId = right.slice(0, -".json".length);
  const leftNumber = Number(leftId);
  const rightNumber = Number(rightId);
  if (
    Number.isSafeInteger(leftNumber) &&
    Number.isSafeInteger(rightNumber) &&
    leftNumber !== rightNumber
  ) {
    return leftNumber - rightNumber;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceItem(value: unknown, filename: string): TasklistReadResult {
  if (!isRecord(value)) {
    return { kind: "invalid", reason: `Claude task file ${filename} is not an object` };
  }
  if (typeof value.subject !== "string") {
    return { kind: "invalid", reason: `Claude task file ${filename} subject is invalid` };
  }
  if (typeof value.status !== "string" || !TASK_STATUSES.has(value.status)) {
    return { kind: "invalid", reason: `Claude task file ${filename} status is invalid` };
  }
  return {
    kind: "updated",
    items: [
      {
        text: value.subject,
        status: value.status as TasklistSourceItem["status"],
      },
    ],
  };
}

function taskRoot(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "tasks");
}

/** Reads one Claude session's current tasklist. `taskRootPath` is injectable
 * for tests; production uses ~/.claude/tasks (or CLAUDE_CONFIG_DIR/tasks). */
export async function readClaudeTasklist(
  sessionId: string,
  taskRootPath = taskRoot(),
): Promise<TasklistReadResult> {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return { kind: "invalid", reason: "Claude tasklist session_id is invalid" };
  }

  const directory = join(taskRootPath, sessionId);
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // TaskUpdate(status=deleted) removes a task file. The session directory
      // itself is the private source contract we are monitoring, so a missing
      // directory must be loud rather than indistinguishable from empty list.
      return { kind: "invalid", reason: "Claude task directory is missing" };
    }
    return {
      kind: "invalid",
      reason: `cannot read Claude task directory: ${String(error)}`,
    };
  }

  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort(taskFileOrder);
  const items: TasklistSourceItem[] = [];

  for (const filename of filenames) {
    let raw: string;
    try {
      raw = await readFile(join(directory, filename), "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return {
        kind: "invalid",
        reason: `cannot read Claude task file ${filename}: ${String(error)}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { kind: "invalid", reason: `Claude task file ${filename} is not JSON` };
    }
    const item = sourceItem(parsed, filename);
    if (item.kind === "invalid") return item;
    items.push(...item.items);
  }
  return { kind: "updated", items };
}
