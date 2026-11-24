#!/usr/bin/env node
// Refuses to switch across a Codex native change unless the operator accepts
// it. There is no state backup: going back across a native change is manual.
import { readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { hasEntry, nativeIdentity } from "./codex-native.mjs";
import { verifyRelease } from "./verify-release.mjs";

const ID = /^(?:[a-f0-9]{40}(?:-dirty)?|unknown)$/;
const ACCEPT = "accept-native-change";
const USAGE =
  `usage: guard <root> <target-id> <"" | ${ACCEPT}> | protected <root>`;

function must(condition, message, exitCode = 78) {
  if (!condition) throw Object.assign(new Error(message), { exitCode });
}
function current(root) {
  const link = readlinkSync(join(root, "current"));
  must(link.startsWith("releases/") && ID.test(link.slice(9)),
    "Invalid current release link");
  return link.slice(9);
}
async function nativeHash(root, id) {
  must(ID.test(id), "Invalid release identity");
  const tree = join(root, "releases", id);
  const v = verifyRelease(tree,
    { requireManifest: true, requireDeployManifest: true, hash: true });
  must(v.identity === id, "Release directory identity mismatch");
  return (await nativeIdentity(tree, v.layout)).sha256;
}
export async function guard(root, target, accept) {
  const candidate = await nativeHash(root, target);
  if (!hasEntry(join(root, "current"))) return;
  const now = await nativeHash(root, current(root));
  must(now === candidate || accept === ACCEPT,
    "Codex native pin differs from the current release");
}
async function main([action, rootArg, ...args]) {
  // No release is retained for Codex state any more, but the operations tool
  // still asks before an update.
  if (action === "protected") {
    must(rootArg !== undefined && args.length === 0, USAGE, 64);
    realpathSync(rootArg);
    return;
  }
  must(action === "guard" && rootArg !== undefined && args.length === 2,
    USAGE, 64);
  must(["", ACCEPT].includes(args[1]), USAGE, 64);
  await guard(realpathSync(rootArg), args[0], args[1]);
}
const invoked = process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(import.meta.filename);
if (invoked) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(`codex-state: ${error.message}`);
    process.exitCode = error.exitCode || 78;
  }
}
