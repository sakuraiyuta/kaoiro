import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { MuseHost } from "@kaoiro/muse";
import { loadConfig, RecoveryReporter } from "@kaoiro/wrapper-core";

const config = loadConfig(process.argv.at(-1), { museEffortWarning: true });
const reporter = new RecoveryReporter(config, config.resume_session_id, () => {}, true);
let ready;
const warnings = [];
const started = new Promise((resolve) => { ready = resolve; });
const host = new MuseHost({
  config,
  cwd: process.cwd(),
  personaPrompt: "persona",
  executable: process.env.MUSE_HOST_FAKE,
  env: { ...process.env, ...(config.resume_session_id ? {} :
    process.env.MUSE_HOST_SCENARIO === "watchdog" ? {
      KAOIRO_TEST_IGNORE_CANCEL: "1", KAOIRO_TEST_CANCEL_FILE: process.env.MUSE_CANCEL_FILE,
    } : {}) },
  recovery: reporter,
  ...(config.resume_session_id ? { resumeSessionId: config.resume_session_id } : {}),
  ...(process.env.MUSE_HOST_SCENARIO === "watchdog" ? { watchdogTimeoutMs: 100 } : {}),
  decidePermission: async () => ({ allow: true }),
  send: (envelope) => {
    if (envelope.type === "log" && envelope.payload.kind === "system" &&
      String(envelope.payload.text).includes("ignores the configured effort")) warnings.push(envelope);
    if (envelope.type === "state_change" && envelope.state === "waiting_input") ready();
  },
});
process.on("SIGTERM", () => host.close());
const run = host.run();
void run.catch(() => {});
await started;
if (config.resume_session_id) {
  if (process.env.MUSE_HOST_SCENARIO === "switch-effort") {
    await host.send("after-switch");
  }
  writeFileSync(process.env.MUSE_RECOVERY_RESULT, JSON.stringify({
    resume: config.resume_session_id, mode: host.statusExtSnapshot().approval_mode,
    initial: config.initial_prompt ?? null,
    ...(process.env.MUSE_HOST_SCENARIO === "switch-effort" ? { warnings: warnings.length } : {}),
  }));
  await run;
} else {
  await host.send("hello");
  if (process.env.MUSE_HOST_SCENARIO === "switch-effort") {
    writeFileSync(process.env.MUSE_SWITCH_READY, JSON.stringify({ warnings: warnings.length }));
    await run;
  } else if (process.env.MUSE_HOST_SCENARIO === "watchdog") {
    const turn = host.send("sleep");
    void turn.catch(() => {});
    while (!existsSync(process.env.MUSE_CANCEL_FILE)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await host.interrupt();
    await run.catch(() => {});
    writeFileSync(process.env.MUSE_RECOVERY_RESULT,
      readFileSync(config.recovery_checkpoint_path));
    process.exitCode = 1;
  } else {
    const turn = host.send("unsafe-mode");
    const queued = host.send("must-not-replay");
    void queued.catch(() => {});
    await turn.catch(() => {});
  }
  await run;
}
