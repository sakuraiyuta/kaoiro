#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateProductionReceipt } from "./production-release-record.mjs";
import { publishProductionRelease } from "./production-release-tags.mjs";
import { validateAutomationGate } from "./release-automation-gate.mjs";
export function validateDispatch(run, { repositoryId, allowedActors }) {
  if (
    !Array.isArray(allowedActors) ||
    allowedActors.length < 1 ||
    allowedActors.length > 100 ||
    allowedActors.some(
      (actor) =>
        typeof actor !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(actor),
    ) ||
    new Set(allowedActors).size !== allowedActors.length
  ) {
    throw new Error(
      "production actor allow-list must be a nonempty unique login array",
    );
  }
  if (
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "develop" ||
    run.repository?.id !== repositoryId ||
    run.head_repository?.id !== repositoryId ||
    !allowedActors.includes(run.actor?.login) ||
    !allowedActors.includes(run.triggering_actor?.login)
  ) {
    throw new Error("production dispatch authority rejected");
  }
}
async function main() {
  validateAutomationGate(
    process.env,
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    "release",
  );
  const repository = process.env.GITHUB_REPOSITORY,
    repositoryId = Number(process.env.GITHUB_REPOSITORY_ID);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("repository context");
  const run = JSON.parse(
    execFileSync(
      "gh",
      ["api", `repos/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 65_536 },
    ),
  );
  validateDispatch(run, {
    repositoryId,
    allowedActors: JSON.parse(process.env.KAOIRO_RELEASE_ACTORS),
  });
  const raw =
    process.argv[2] === "validate"
      ? process.env.KAOIRO_RELEASE_RECEIPT
      : readFileSync(process.argv[3], "utf8");
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 16_384)
    throw new Error("production receipt exceeds input bound");
  const receipt = JSON.parse(raw);
  validateProductionReceipt(receipt, {
    repositoryId,
    allowedHosts: JSON.parse(process.env.KAOIRO_RELEASE_HOST_IDS),
  });
  if (process.argv[2] === "validate") {
    writeFileSync(process.argv[3], `${JSON.stringify(receipt)}\n`, {
      flag: "wx",
    });
    return;
  }
  if (process.argv[2] !== "publish") throw new Error("unknown receiver action");
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
  process.env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString("base64")}`;
  const result = publishProductionRelease({
    cwd: process.cwd(),
    receipt,
    repositoryId,
    allowedHosts: JSON.parse(process.env.KAOIRO_RELEASE_HOST_IDS),
  });
  console.log(
    JSON.stringify({
      attempt_uuid: receipt.attempt_uuid,
      revision: receipt.revision,
      version: receipt.version,
      ...result,
    }),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`production workflow: ${error.message}\n`);
    process.exitCode = 78;
  }
}
