import { readFileSync, writeFileSync } from "node:fs";
import { RecoveryReporter } from "@kaoiro/wrapper-core";

const config = JSON.parse(readFileSync(process.argv.at(-1), "utf8"));
const reporter = new RecoveryReporter(config, config.resume_session_id, () => {});
if (!config.resume_session_id) {
  if (!reporter.observe("fixture-session")) process.exit(79);
  process.exit(1);
}
writeFileSync(process.env.MUSE_RECOVERY_RESULT, JSON.stringify(config));
setInterval(() => {}, 1_000);
