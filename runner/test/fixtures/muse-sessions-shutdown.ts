import { existsSync } from "node:fs";
import { runRunnerCli } from "../../src/runner-cli.js";
import type { RunnerLinkOptions } from "../../src/transport.js";

let options: RunnerLinkOptions;
const link = {
  sendSpawnResult() {}, sendSessions() {}, sendResetResult() {}, sendStopAgent() {},
  sendCatalogResult() {}, updateRegister() {}, reconnect() {}, close() {},
};
await runRunnerCli({
  resolveCodexAuthMode: async () => "unknown",
  createRunnerLink: (_url, _host, value) => { options = value; return link; },
  watchRunnerConfig: () => ({ close() {} }),
  makeLauncher: () => () => { throw new Error("no wrapper"); },
}, [process.env.OWN_CONFIG!]);
options!.onEnumerateSessions?.({ cwd: process.env.OWN_CWD!, engine: "muse" });
const timer = setInterval(() => {
  if (!existsSync(process.env.FAKE_MUSE_PIDS!)) return;
  clearInterval(timer);
  process.kill(process.pid, "SIGTERM");
}, 20);
