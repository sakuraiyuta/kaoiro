import { describe, expect, it } from "vitest";
import { NON_INTERACTIVE_GIT_SSH_COMMAND, nonInteractiveToolEnv } from "../src/tool_child_env.js";

describe("nonInteractiveToolEnv (issue #350)", () => {
  it("injects the three prompt-disabling values when the operator set no GIT_SSH_COMMAND", () => {
    expect(nonInteractiveToolEnv({ PATH: "/usr/bin" })).toEqual({
      additions: {
        GIT_TERMINAL_PROMPT: "0",
        SSH_ASKPASS_REQUIRE: "never",
        GIT_SSH_COMMAND: NON_INTERACTIVE_GIT_SSH_COMMAND,
      },
      preservedGitSshCommand: false,
    });
    expect(NON_INTERACTIVE_GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
  });

  it("treats an empty GIT_SSH_COMMAND as absent", () => {
    expect(nonInteractiveToolEnv({ GIT_SSH_COMMAND: "" })).toMatchObject({
      additions: { GIT_SSH_COMMAND: NON_INTERACTIVE_GIT_SSH_COMMAND },
      preservedGitSshCommand: false,
    });
  });

  it("keeps an operator GIT_SSH_COMMAND untouched while still disabling git and askpass prompts", () => {
    const result = nonInteractiveToolEnv({ GIT_SSH_COMMAND: "/opt/wrap-ssh --audit" });
    expect(result).toEqual({
      additions: { GIT_TERMINAL_PROMPT: "0", SSH_ASKPASS_REQUIRE: "never" },
      preservedGitSshCommand: true,
    });
    expect(Object.keys(result.additions)).not.toContain("GIT_SSH_COMMAND");
  });
});
