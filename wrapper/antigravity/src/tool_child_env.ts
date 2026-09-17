/** `ssh` options that disable every interactive prompt (`man ssh_config`,
 *  BatchMode). Injected as `GIT_SSH_COMMAND` only when the operator did not
 *  set one, so a wrapper script of theirs keeps working unchanged. */
export const NON_INTERACTIVE_GIT_SSH_COMMAND = "ssh -o BatchMode=yes";

export interface NonInteractiveToolEnv {
  /** Variables merged over the agy child's environment. */
  additions: Readonly<Record<string, string>>;
  /** True when an operator-supplied `GIT_SSH_COMMAND` was left untouched. */
  preservedGitSshCommand: boolean;
}

/**
 * Environment additions that make git / ssh inside an agy tool child fail
 * fast instead of blocking on a TTY prompt. The agy tool child owns a PTY,
 * so closing the parent's stdin alone cannot prevent the prompt.
 */
export function nonInteractiveToolEnv(
  env: Readonly<Record<string, string | undefined>>,
): NonInteractiveToolEnv {
  const existing = env.GIT_SSH_COMMAND;
  const preservedGitSshCommand = existing !== undefined && existing !== "";
  return {
    additions: {
      GIT_TERMINAL_PROMPT: "0",
      SSH_ASKPASS_REQUIRE: "never",
      ...(preservedGitSshCommand ? {} : { GIT_SSH_COMMAND: NON_INTERACTIVE_GIT_SSH_COMMAND }),
    },
    preservedGitSshCommand,
  };
}
