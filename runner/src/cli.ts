import {
  installRunnerUnhandledHandlers,
  runRunnerCli,
} from "./runner-cli.js";

/** `kaoiro runner [config]` and `kaoiro --version`, called by the kaoiro
 *  entry. Not awaited: a failure is reported by the handlers installed here. */
export function runRunner(argv: string[]): void {
  installRunnerUnhandledHandlers();
  void runRunnerCli({}, argv);
}
