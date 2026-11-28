import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { MuseHost } from "@kaoiro/muse";
import { RecoveryReporter } from "@kaoiro/wrapper-core";

const config = JSON.parse(readFileSync(process.argv.at(-1), "utf8"));
class Reporter extends RecoveryReporter {
  confirm(id, delivered) {
    const marker = process.env.MUSE_RESPONSE_CRASH_MARKER;
    if (marker && !config.resume_session_id && !existsSync(marker)) {
      writeFileSync(marker, "crash before checkpoint");
      process.exit(1);
    }
    return super.confirm(id, delivered);
  }
}
const reporter = new Reporter(config, config.resume_session_id, () => {}, true);
let ready;
const started = new Promise((resolve) => { ready = resolve; });
const host = new MuseHost({
  config, cwd: process.cwd(), personaPrompt: "PERSONA_AND_FOOTER",
  executable: process.env.MUSE_HOST_FAKE, env: process.env, recovery: reporter,
  ...(config.resume_session_id ? { resumeSessionId: config.resume_session_id } : {}),
  decidePermission: async () => ({ allow: true }),
  send: (envelope) => { if (envelope.type === "state_change" &&
    envelope.state === "waiting_input") ready(); },
});
process.on("SIGTERM", () => host.close());
const run = host.run();
void run.catch(() => {});
await started;
if (!config.resume_session_id) {
  await host.send("first");
  host.close();
  await run;
  process.exitCode = 1;
} else {
  await host.send("second");
  writeFileSync(process.env.MUSE_RECOVERY_RESULT, JSON.stringify({
    resume: config.resume_session_id,
    delivered: config.muse_persona_delivered ?? false,
    checkpoint: JSON.parse(readFileSync(config.recovery_checkpoint_path, "utf8")),
  }));
  await run;
}
