// Entry point for the runner setup wizard (issue #144). The flow itself lives
// in setup.ts; this only wires readline to it.
//
// Usage: node dist/setup.js     (or deploy/kaoiro-runner-setup.sh)

import { platform } from "node:os";
import { createInterface } from "node:readline/promises";
import { ConfigError } from "./config.js";
import { type Prompt, nextSteps, runSetup } from "./setup.js";

async function main(): Promise<void> {
  // A wizard reached from a service manager (systemd / launchd) would have no
  // terminal and would loop forever on EOF, so refuse up front. 78 =
  // EX_CONFIG, matching the launch shim's configuration-error status.
  // Non-interactive setup is issue #146.
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "kaoiro-runner-setup: needs an interactive terminal" +
        " (non-interactive setup: issue #146)\n",
    );
    process.exit(78);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let finished = false;
  // Ctrl-C / Ctrl-D closes the interface mid-question; without this the
  // pending question resolves empty and the validation loops re-ask forever.
  rl.on("close", () => {
    if (!finished) {
      process.stderr.write("\nkaoiro-runner-setup: aborted\n");
      process.exit(130);
    }
  });

  const prompt: Prompt = {
    ask: async (question, fallback) => {
      const suffix = fallback === undefined || fallback === "" ? "" : ` [${fallback}]`;
      const answer = await rl.question(`${question}${suffix}: `);
      return answer === "" && fallback !== undefined ? fallback : answer;
    },
    confirm: async (question, fallback) => {
      const answer = (
        await rl.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"}: `)
      )
        .trim()
        .toLowerCase();
      if (answer === "") return fallback;
      return answer === "y" || answer === "yes";
    },
    info: (message) => {
      process.stdout.write(`${message}\n`);
    },
  };

  process.stdout.write("kaoiro runner setup\n\n");

  let result;
  try {
    result = await runSetup(prompt, {
      env: process.env,
      platform: platform(),
    });
  } catch (error) {
    // runSetup validates through parseRunnerConfig before writing. A rejection
    // here means the wizard built something the loader refuses — report it as
    // a config error instead of dumping a stack trace over the operator's
    // answers.
    finished = true;
    rl.close();
    if (error instanceof ConfigError) {
      process.stderr.write(
        `kaoiro-runner-setup: the answers did not form a valid config: ${error.message}\n`,
      );
      process.exit(78);
    }
    throw error;
  }

  process.stdout.write("\nDone.\n\n");
  for (const line of nextSteps(result, result.token)) {
    process.stdout.write(`${line}\n`);
  }

  finished = true;
  rl.close();
}

void main();
