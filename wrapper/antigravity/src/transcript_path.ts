import { homedir } from "node:os";
import { join } from "node:path";

/** Absolute path to a conversation's transcript JSONL (issue #352). Pattern
 *  measured from the PreToolUse hook payload's `transcriptPath` field
 *  (docs/specs/antigravity-cli-events.md, "Permission"); `conversationId` is
 *  the CLI's own id, reported by the wrapper as the kaoiro session id. */
export function antigravityTranscriptPath(conversationId: string): string {
  return join(
    homedir(),
    ".gemini",
    "antigravity-cli",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );
}
