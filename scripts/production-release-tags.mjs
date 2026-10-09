import { execChildSync } from "./child-process-environment.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BUILD_REPOSITORY_ID, readLandingTag } from "./build-identity.mjs";
import {
  receiptDigest,
  validateProductionReceipt,
} from "./production-release-record.mjs";
const git = (cwd, args) =>
  execChildSync("ci-git", "git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  }).trim();
const optional = (cwd, args) => {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
};
function readPair(cwd, receipt, run = git) {
  const maybe = (directory, args) => {
    try {
      return run(directory, args);
    } catch (error) {
      if (error.status === 128 && !error.signal) return null;
      throw error;
    }
  };
  const tag = `release/v${receipt.version}`;
  const claim = `identity/release/production/${receipt.revision}`;
  const object = maybe(cwd, ["rev-parse", "--verify", `refs/tags/${claim}`]);
  if (!object) {
    if (maybe(cwd, ["rev-parse", "--verify", `refs/tags/${tag}`]))
      throw new Error("release public tag exists without its claim");
    return null;
  }
  if (run(cwd, ["cat-file", "-t", object]) !== "tag")
    throw new Error("release claim is not annotated");
  const raw = run(cwd, ["cat-file", "-p", object]);
  if (Buffer.byteLength(raw) > 4_096)
    throw new Error("release annotation exceeds bound");
  const split = raw.indexOf("\n\n");
  const header = raw.slice(0, split).split("\n");
  const record = JSON.parse(raw.slice(split + 2));
  if (
    header[0] !== `object ${receipt.revision}` ||
    header[1] !== "type commit" ||
    header[2] !== `tag ${tag}` ||
    run(cwd, ["rev-parse", "--verify", `refs/tags/${tag}`]) !== object ||
    record.schema !== 1 ||
    record.kind !== "production_release" ||
    record.repository_id !== receipt.repository_id ||
    record.environment !== "production" ||
    record.publication_mode !== "by_landing" ||
    record.revision !== receipt.revision ||
    record.version !== receipt.version ||
    record.branch !== receipt.branch ||
    Object.keys(record).sort().join() !==
      [
        "schema",
        "kind",
        "repository_id",
        "environment",
        "publication_mode",
        "revision",
        "version",
        "branch",
        "first_attempt_uuid",
        "completed_at",
        "first_receipt_sha256",
      ]
        .sort()
        .join() ||
    typeof record.first_attempt_uuid !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      record.first_attempt_uuid,
    ) ||
    typeof record.completed_at !== "string" ||
    !Number.isFinite(Date.parse(record.completed_at)) ||
    new Date(record.completed_at).toISOString() !== record.completed_at ||
    typeof record.first_receipt_sha256 !== "string" ||
    record.first_receipt_sha256.length !== 64 ||
    !/^[0-9a-f]{64}$/.test(record.first_receipt_sha256)
  ) {
    throw new Error("release tag/claim/identity disagree");
  }
  return { tag, claim, object, record, reused: true };
}
export function readPublishedProductionRelease({
  cwd,
  receipt,
  repositoryId = BUILD_REPOSITORY_ID,
  allowedHosts,
  remote = "origin",
  refresh = true,
  remoteInventory,
  gitReader = git,
}) {
  validateProductionReceipt(receipt, { repositoryId, allowedHosts });
  if (refresh) gitReader(cwd, ["fetch", "--tags", remote]);
  const landing = readLandingTag(cwd, `v${receipt.version}`, repositoryId, {
    gitReader: (args, directory) => gitReader(directory, args),
  });
  if (landing.record.revision !== receipt.revision)
    throw new Error("release read-back target differs from landing claim");
  const pair = readPair(cwd, receipt, gitReader);
  if (!pair) throw new Error("release publication has not been acknowledged");
  const inventory =
    remoteInventory ??
    gitReader(cwd, ["ls-remote", "--refs", "--tags", remote]).split("\n");
  if (
    !inventory.includes(`${pair.object}\trefs/tags/${pair.tag}`) ||
    !inventory.includes(`${pair.object}\trefs/tags/${pair.claim}`) ||
    !inventory.includes(`${landing.object}\trefs/tags/${landing.tag}`) ||
    !inventory.includes(
      `${landing.object}\trefs/tags/identity/landing/${receipt.revision}`,
    )
  ) {
    throw new Error("release read-back remote pair differs");
  }
  return pair;
}
export function publishProductionRelease({
  cwd,
  receipt,
  repositoryId = BUILD_REPOSITORY_ID,
  allowedHosts,
  remote = "origin",
  retries = 5,
}) {
  validateProductionReceipt(receipt, { repositoryId, allowedHosts });
  for (let attempt = 0; attempt < retries; attempt++) {
    git(cwd, ["fetch", "--tags", remote]);
    const landing = readLandingTag(cwd, `v${receipt.version}`, repositoryId);
    if (landing.record.revision !== receipt.revision)
      throw new Error("receipt target differs from exact landing claim");
    const existing = readPair(cwd, receipt);
    if (existing) return existing;
    const tag = `release/v${receipt.version}`;
    const claim = `identity/release/production/${receipt.revision}`;
    const record = {
      schema: 1,
      kind: "production_release",
      repository_id: repositoryId,
      environment: "production",
      publication_mode: "by_landing",
      revision: receipt.revision,
      version: receipt.version,
      branch: receipt.branch,
      first_attempt_uuid: receipt.attempt_uuid,
      completed_at: receipt.completed_at,
      first_receipt_sha256: receiptDigest(receipt),
    };
    git(cwd, [
      "-c",
      "user.name=kaoiro release",
      "-c",
      "user.email=release@kaoiro.invalid",
      "tag",
      "-a",
      tag,
      receipt.revision,
      "-m",
      JSON.stringify(record),
    ]);
    const object = git(cwd, ["rev-parse", `refs/tags/${tag}`]);
    git(cwd, ["update-ref", `refs/tags/${claim}`, object]);
    try {
      git(cwd, [
        "push",
        "--atomic",
        remote,
        `refs/tags/${tag}`,
        `refs/tags/${claim}`,
      ]);
    } catch {
      // These are disposable local proposals; immutable remote refs are never deleted.
      git(cwd, ["update-ref", "-d", `refs/tags/${tag}`, object]);
      git(cwd, ["update-ref", "-d", `refs/tags/${claim}`, object]);
      git(cwd, ["fetch", "--tags", remote]);
      const accepted = readPair(cwd, receipt);
      if (accepted) return accepted;
      continue;
    }
    const inventory = git(cwd, ["ls-remote", "--refs", "--tags", remote]).split(
      "\n",
    );
    if (
      !inventory.includes(`${object}\trefs/tags/${tag}`) ||
      !inventory.includes(`${object}\trefs/tags/${claim}`)
    ) {
      throw new Error("release publication read-back failed");
    }
    return { tag, claim, object, record, reused: false };
  }
  throw new Error("release publication exhausted bounded retries");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const receipt = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const result = publishProductionRelease({
      cwd: process.cwd(),
      receipt,
      repositoryId: Number(process.env.KAOIRO_REPOSITORY_ID),
      allowedHosts: JSON.parse(process.env.KAOIRO_RELEASE_HOST_IDS),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 78;
  }
}
