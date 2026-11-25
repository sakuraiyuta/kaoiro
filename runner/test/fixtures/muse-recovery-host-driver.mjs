import { readFileSync, writeFileSync } from "node:fs";
import { MuseHost } from "@kaoiro/muse";
import { RecoveryReporter } from "@kaoiro/wrapper-core";

const config = JSON.parse(readFileSync(process.argv.at(-1), "utf8"));
const reporter = new RecoveryReporter(config, config.resume_session_id, () => {});
let ready;
const started = new Promise((resolve) => { ready = resolve; });
const host = new MuseHost({
  config,
  cwd: process.cwd(),
  personaPrompt: "persona",
  executable: process.env.MUSE_HOST_FAKE,
  env: { ...process.env, ...(config.resume_session_id ? {} :
    process.env.MUSE_HOST_SCENARIO === "switch" ? { KAOIRO_TEST_HANG_SWITCH: "1" } : {}) },
  recovery: reporter,
  ...(config.resume_session_id ? { resumeSessionId: config.resume_session_id } : {}),
  switchTimeoutMs: 100,
  decidePermission: async () => ({ allow: true }),
  send: (envelope) => { if (envelope.type === "state_change" &&
    envelope.state === "waiting_input") ready(); },
});
process.on("SIGTERM", () => host.close());
const run = host.run();
void run.catch(() => {});
await started;
if (config.resume_session_id) {
  writeFileSync(process.env.MUSE_RECOVERY_RESULT, JSON.stringify({
    resume: config.resume_session_id, mode: host.statusExtSnapshot().approval_mode,
    initial: config.initial_prompt ?? null,
  }));
  await run;
} else {
  await host.send("hello");
  if (process.env.MUSE_HOST_SCENARIO === "switch") {
    const switching = host.setModel("muse-wonder");
    const queued = host.send("must-not-replay");
    void queued.catch(() => {});
    await switching.catch(() => {});
  } else {
    const turn = host.send("unsafe-mode");
    const queued = host.send("must-not-replay");
    void queued.catch(() => {});
    await turn.catch(() => {});
  }
  await run;
}
