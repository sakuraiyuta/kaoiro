import {
  installRunnerUnhandledHandlers,
  runRunnerCli,
} from "./runner-cli.js";

async function main(): Promise<void> {
  installRunnerUnhandledHandlers();
  await runRunnerCli();
}

void main();
