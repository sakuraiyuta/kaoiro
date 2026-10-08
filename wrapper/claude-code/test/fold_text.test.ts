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
});
