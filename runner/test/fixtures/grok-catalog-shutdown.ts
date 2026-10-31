// Runs the runner CLI with its own signal handlers and a Grok catalog
// probe on the fake, then sends itself SIGTERM once the fake has started,
// as an operator stop does. OWN_CONFIG is the runner config; FAKE_EXECUTABLE
// is the probe's executable; FAKE_GROK_PIDS is written by the fake.
import { existsSync } from "node:fs";
import { runRunnerCli } from "../../src/runner-cli.js";

const link = {
  sendSpawnResult() {}, sendSessions() {}, sendResetResult() {}, sendStopAgent() {},
  sendCodexWorkObserved() {},
  sendCatalogResult() {}, updateRegister() {}, reconnect() {}, close() {},
};
await runRunnerCli({
  resolveCodexAuthMode: async () => "unknown",
  createRunnerLink: () => link,
  watchRunnerConfig: () => ({ close() {} }),
  grokCatalogProbe: { cwd: process.cwd(), executable: process.env.FAKE_EXECUTABLE!, env: process.env },
}, [process.env.OWN_CONFIG!]);
const timer = setInterval(() => {
  if (!existsSync(process.env.FAKE_GROK_PIDS!)) return;
  clearInterval(timer);
  process.kill(process.pid, "SIGTERM");
}, 20);
