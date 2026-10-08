import { describe, expect, it } from "vitest";
import { REPLY_AUTHORIZATION_USAGE_GUIDANCE } from "@kaoiro/agent-common";
import { formatClaudeFoldText } from "../src/fold_text.js";

describe("Claude fold text", () => {
  it("includes reply authorization guidance only when authorizations are present", () => {
    const authorization = { in_reply_to: 4, reply_ticket: "ticket", expires_in_ms: 30_000 };
    const withAuthorization = formatClaudeFoldText("fold-1", "peer input", [authorization]);
    const withoutAuthorization = formatClaudeFoldText("fold-2", "peer input", []);

    expect(withAuthorization).toContain(REPLY_AUTHORIZATION_USAGE_GUIDANCE);
    expect(withAuthorization).toContain(`reply_authorization: ${JSON.stringify(authorization)}`);
    expect(withoutAuthorization).not.toContain(REPLY_AUTHORIZATION_USAGE_GUIDANCE);
    expect(withoutAuthorization).not.toContain("reply_authorization:");
  });

  it("includes guidance once after the batch and before multiple authorization lines", () => {
    const authorizations = [
      { in_reply_to: 4, reply_ticket: "ticket-4", expires_in_ms: 30_000 },
      { in_reply_to: 8, reply_ticket: "ticket-8", expires_in_ms: 30_000 },
    ];
    // "peer input" would also match the fixed preamble, which ends "with this
    // peer input.", so the batch text must be a string the preamble lacks.
    const text = formatClaudeFoldText("fold-2", "batch body", authorizations);
    const firstAuthorizationLine = text.indexOf(
      `reply_authorization: ${JSON.stringify(authorizations[0])}`,
    );
    const secondAuthorizationLine = text.indexOf(
      `reply_authorization: ${JSON.stringify(authorizations[1])}`,
    );
    const guidance = text.indexOf(REPLY_AUTHORIZATION_USAGE_GUIDANCE);

    expect(text.split(REPLY_AUTHORIZATION_USAGE_GUIDANCE)).toHaveLength(2);
    expect(text).toContain(
      `batch body\n\n${REPLY_AUTHORIZATION_USAGE_GUIDANCE}\n\nreply_authorization: ${JSON.stringify(authorizations[0])}`,
    );
    expect(guidance).toBeLessThan(firstAuthorizationLine);
    expect(firstAuthorizationLine).toBeLessThan(secondAuthorizationLine);
  });
});
