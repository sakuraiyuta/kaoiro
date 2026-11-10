import { readFileSync } from "node:fs";

// Captured from SDK 0.3.321 / CLI 2.1.321 completion notifications: `sdk` is
// the summary of the SDK's task_notification frame and `shown` the summary of
// the block the CLI gave the model. Only the Monitor continuation token was
// replaced, by the same-length placeholder below.
export const completionSummaries = (JSON.parse(readFileSync(
  new URL("./claude-cli-2.1.321-completion-summaries.json", import.meta.url), "utf8")) as {
  cases: Array<{ id: string; sdk: string; shown: string }>;
}).cases;

export const FIXTURE_TOKEN = "fixture-token-00000000000000000000000000000";

export function completionSummary(id: string): { sdk: string; shown: string } {
  const found = completionSummaries.find(value => value.id === id);
  if (!found) throw Error(`No captured completion summary ${id}`);
  return found;
}
