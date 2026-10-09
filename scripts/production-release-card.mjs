#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateProductionReceipt,
  receiptDigest,
} from "./production-release-record.mjs";
import { validateFrozenBuildIdentity } from "./build-identity.mjs";
import { readPublishedProductionRelease } from "./production-release-tags.mjs";
import { readReleaseHistory } from "./production-release-history.mjs";
import { readReleaseAuthority } from "./production-release-authority.mjs";
import { readPrivateJson } from "./production-release-files.mjs";
import { parseReleaseOptions } from "./production-release-state.mjs";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const read = (file) => {
  const raw = readFileSync(file);
  if (raw.length > 524_288) throw new Error("completion input exceeds bound");
  return JSON.parse(raw);
};
const must = (value, message) => {
  if (!value) throw new Error(message);
};
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
function completedAttempt(dir) {
  const plan = readPrivateJson(join(dir, "attempt.json")),
    receipt = readPrivateJson(join(dir, "completion.json"));
  validateFrozenBuildIdentity(plan.identity);
  validateProductionReceipt(receipt, {
    repositoryId: plan.identity.landing.repository_id,
    allowedHosts: plan.host_ids,
  });
  must(
    UUID.test(plan.attempt_uuid) &&
      basename(resolve(dir)) === plan.attempt_uuid &&
      receipt.attempt_uuid === plan.attempt_uuid &&
      receipt.revision === plan.identity.revision &&
      receipt.version === plan.identity.version &&
      receipt.branch === plan.identity.branch &&
      JSON.stringify([...receipt.host_ids].sort()) ===
        JSON.stringify(plan.host_ids) &&
      JSON.stringify([...receipt.codex_host_ids].sort()) ===
        JSON.stringify(plan.codex_host_ids),
    "completion/card attempt differs",
  );
  return { plan, receipt };
}
export function productionDispatchCard({
  dir,
  cwd,
  repository = "sakuraiyuta/kaoiro",
}) {
  must(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
    "invalid fixed repository",
  );
  const { receipt, plan } = completedAttempt(dir);
  must(plan.authority?.server, "production card requires enrolled authority");
  const authority = readReleaseAuthority(plan.authority.server.root, {
    role: "server",
    expectedDigest: plan.authority.server.sha256,
  });
  must(
    authority.status === "enrolled" &&
      authority.descriptor.transport === "local",
    "canonical card authority required",
  );
  const tools = resolve(cwd),
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: tools,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 5000,
    }).trim();
  must(/^[0-9a-f]{40}$/.test(head), "reviewed tool commit unavailable");
  const dispatch = `gh workflow run production-release.yml --repo ${quote(repository)} --ref develop -f ${quote(`receipt=${JSON.stringify(receipt)}`)}`;
  const launcher = quote(authority.descriptor.exporter_path),
    node = quote(authority.descriptor.node_path),
    digest = quote(authority.descriptor.tool_sha256);
  const verification =
    `${node} ${launcher} collect ${digest} ack --server-dir ${quote(authority.root)} --attempt ${quote(resolve(dir))} --repo ${quote(tools)}` +
    ` && ${node} ${launcher} audit ${digest} --install-root ${quote(authority.root)} --expected-authority-sha256 ${quote(authority.sha256)} --role card --repo ${quote(tools)}`;
  const landingAudit = `${quote(process.execPath)} ${quote(join(tools, "scripts/landing-repair.mjs"))} audit --repository ${quote(repository)}`;
  const command = `${landingAudit} && ${dispatch} && ${verification}`;
  return {
    schema: 1,
    attempt_uuid: receipt.attempt_uuid,
    revision: receipt.revision,
    version: receipt.version,
    receipt_sha256: receiptDigest(receipt),
    tools_revision: head,
    tools_sha256: authority.descriptor.tool_sha256,
    repository,
    workflow: "production-release.yml",
    ref: "develop",
    command,
    landing_audit: landingAudit,
    dispatch,
    verification,
    notice:
      "Run with the operator's own gh after canary. Dispatch success is not publication acknowledgment; verification must exit 0 after both remote refs agree.",
  };
}
export function auditProductionCompletions({ root, cwd, remote = "origin" }) {
  const history = readReleaseHistory(root);
  const completed = history.rows.filter(
    (row) => row.completion && row.state.id === "publication_unconfirmed",
  );
  let inventory;
  if (completed.length) {
    execFileSync("git", ["fetch", "--tags", remote], {
      cwd,
      timeout: 15_000,
      stdio: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    inventory = execFileSync("git", ["ls-remote", "--refs", "--tags", remote], {
      cwd,
      timeout: 15_000,
      encoding: "utf8",
      stdio: "pipe",
    })
      .trim()
      .split("\n");
  }
  const rows = history.archived_incidents.map((incident) => ({
    ...incident,
    archived: true,
  }));
  for (const row of history.rows) {
    const name = row.attempt_uuid;
    if (!row.completion || row.state.id !== "publication_unconfirmed") {
      rows.push({ attempt_uuid: name, status: row.state.id });
      continue;
    }
    const { completion: receipt, plan } = row;
    try {
      const pair = readPublishedProductionRelease({
        cwd,
        receipt,
        remote,
        repositoryId: receipt.repository_id,
        allowedHosts: plan.host_ids,
        refresh: false,
        remoteInventory: inventory,
      });
      rows.push({
        attempt_uuid: name,
        revision: receipt.revision,
        status: "published",
        tag: pair.tag,
        object: pair.object,
      });
    } catch (error) {
      rows.push({
        attempt_uuid: name,
        revision: receipt.revision,
        status:
          error.message === "release publication has not been acknowledged"
            ? "publication_missing"
            : "publication_unconfirmed",
      });
    }
  }
  return rows;
}
async function main() {
  const [command, ...args] = process.argv.slice(2),
    flags = parseReleaseOptions(args, [
      "attempt",
      "repo",
      "repository",
      "root",
    ]);
  if (command === "card")
    console.log(
      JSON.stringify(
        productionDispatchCard({
          dir: flags.attempt,
          cwd: flags.repo,
          repository: flags.repository,
        }),
        null,
        2,
      ),
    );
  else if (command === "audit") {
    const rows = auditProductionCompletions({
      root: flags.root,
      cwd: flags.repo,
    });
    console.log(JSON.stringify(rows, null, 2));
    if (
      rows.some(
        (row) =>
          ![
            "published",
            "abandoned",
            "invalid_quarantined",
            "deployed_uncompleted",
          ].includes(row.status),
      )
    )
      process.exitCode = 1;
  } else throw new Error("unknown production dispatch command");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
