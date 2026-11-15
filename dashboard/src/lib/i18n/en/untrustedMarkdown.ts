import type { Messages } from "../ja";

export const untrustedMarkdown = {
  pendingNote: "Formatting; the complete source is shown while waiting",
  unavailableNote: "Formatting is unavailable. Reload the page to try again",
  plainNote: "Shown as plain text because the formatting cannot be displayed",
} satisfies Messages["untrustedMarkdown"];
