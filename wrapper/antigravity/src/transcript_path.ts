import { homedir } from "node:os";
import { join } from "node:path";

/** Absolute path to a conversation's transcript JSONL (issue #352).
 *  `conversationId` is the ACP session ID, which the wrapper reports as the
 *  kaoiro session id. The layout is checked for `agy` 1.5.14 in
 *  docs/evidence/antigravity/agy-1.5.14-acp-native-acceptance-2026-11-23.md. */
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
