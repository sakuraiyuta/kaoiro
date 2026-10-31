import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const suffix = Buffer.from('\nexport { imageHasPersistencePathsModule, queryPersistencePaths, namedVolumeExists };\n');
const hash = data => createHash('sha256').update(data).digest('hex');
const git = (...args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
const target = 'server/deploy/kaoiro-server-deploy.mjs';
const paths = ['.gitignore', 'server/deploy', 'scripts', 'runner/deploy'];
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

export function archiveCopy(repo, sha, dir) {
  mkdirSync(dir, { recursive: true });
  const archive = git('-C', repo, 'archive', sha, ...paths);
  execFileSync('tar', ['-x', '-C', dir], { input: archive });
  const p = join(dir, target);
  writeFileSync(p, Buffer.concat([readFileSync(p), suffix]));
  verifyCopy(repo, sha, dir);
}

export function verifyCopy(repo, sha, dir) {
  const entries = git('-C', repo, 'ls-tree', '-r', '-z', '--name-only', sha, '--', ...paths).toString('utf8').split('\0').filter(Boolean);
  ensure(entries.includes(target), 'missing module in archive');
  for (const path of entries) {
    const original = git('-C', repo, 'show', `${sha}:${path}`);
    const copy = readFileSync(join(dir, path));
    const expected = path === target ? Buffer.concat([original, suffix]) : original;
    ensure(copy.equals(expected), `copy mismatch: ${path}`);
    if (path === target) console.log(JSON.stringify({ case: 'module-copy', sha, path: resolve(dir, path), originalSha256: hash(original), suffixSha256: hash(suffix), copySha256: hash(copy) }));
  }
}

const beforeInput = 'withNewWorkStore({ oldEvalOutput: OLD_WORK_STORE_MANIFEST }, () =>\n      runUpdate(workStoreFlags(), configWithOverride())));';
const afterInput = 'withNewWorkStore({ oldEvalOutput: readFileSync(process.env.KAOIRO_PROBE_MANIFEST, "utf8") }, () =>\n      runUpdate(workStoreFlags(), configWithOverride())));';
const beforePath = 'assert.ok(caught.message.includes("/tmp/old-work.dets"));';
const afterPath = 'assert.ok(caught.message.includes(JSON.parse(readFileSync(process.env.KAOIRO_PROBE_MANIFEST, "utf8")).find(e => e.env === "KAOIRO_WORK_STORE_PATH").default_path));';
const replaces = [[beforeInput, afterInput], [beforePath, afterPath]];
export function transformOldTest(original) {
  let text = original.toString('utf8');
  ensure(Buffer.from(text).equals(original), 'test is not UTF-8');
  for (const [before, after] of replaces) {
    ensure(text.split(before).length === 2, 'test replacement must match once');
    text = text.replace(before, () => after);
  }
  return Buffer.from(text);
}
export function writeOldTest(repo, sha, dir) {
  const path = 'server/deploy/test/deploy.test.mjs';
  const original = git('-C', repo, 'show', `${sha}:${path}`);
  const out = join(dir, 'server/deploy/test/issue-920-probe.test.mjs');
  const expected = transformOldTest(original);
  writeFileSync(out, expected);
  ensure(readFileSync(out).equals(transformOldTest(original)), 'test copy mismatch');
  console.log(JSON.stringify({ case: 'old-test-copy', originalSha256: hash(original), copySha256: hash(expected), replacements: replaces.map(([before, after]) => ({ before, after, beforeSha256: hash(before), afterSha256: hash(after) })), path: out }));
  return out;
}

export function canonical(entries) {
  ensure(Array.isArray(entries) && entries.length > 0, 'manifest must be a nonempty array');
  const keys = ['store', 'env', 'default_file', 'default_path'];
  const tuples = entries.map(entry => {
    ensure(entry && keys.every(k => typeof entry[k] === 'string' && entry[k].length > 0), 'bad manifest entry');
    return keys.map(k => entry[k]);
  });
  return tuples.sort((a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; });
}
export function compareManifest(entries, expected) {
  ensure(JSON.stringify(canonical(entries)) === JSON.stringify(expected), 'manifest differs from pinned expected list');
}

export const ARGV_RECORDER = 'require("node:fs").appendFileSync(process.env.KAOIRO_PROBE_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\n';

export function writeVolumeTest(repo, sha, dir) {
  const path = 'server/deploy/test/deploy.test.mjs';
  const original = git('-C', repo, 'show', `${sha}:${path}`).toString('utf8');
  const start = 'const FAKE_DOCKER = `#!/bin/sh\n';
  const shell = `const FAKE_DOCKER = \`#!/bin/sh\nnode "$KAOIRO_PROBE_ARGV_SCRIPT" "$@"\n`;
  const label = 'test("new-store guard never creates a missing target volume", () => {\n';
  const activate = label + '  process.env.KAOIRO_PROBE_ARGV_LOG = join(root, "probe-argv.jsonl");\n' +
    '  process.env.KAOIRO_PROBE_ARGV_SCRIPT = join(root, "probe-argv.cjs");\n' +
    `  writeFileSync(process.env.KAOIRO_PROBE_ARGV_SCRIPT, ${JSON.stringify(ARGV_RECORDER)});\n`;
  const end = '  assert.doesNotMatch(calls, /^volume create|^run .*?(?:--mount| -v )|^compose stop|^compose up|archive/m);\n});\n\ntest("stable store ID refuses';
  const check = `  assert.doesNotMatch(calls, /^volume create|^run .*?(?:--mount| -v )|^compose stop|^compose up|archive/m);\n  const argv = readFileSync(process.env.KAOIRO_PROBE_ARGV_LOG, "utf8").trim().split("\\n").map(JSON.parse);\n  if (process.env.KAOIRO_PROBE_VOLUME_MUTANT) argv.push(JSON.parse(process.env.KAOIRO_PROBE_VOLUME_MUTANT));\n  console.log("ISSUE920_VOLUME_ARGV " + JSON.stringify(argv));\n  assert.ok(argv.some(a => a[0] === "volume" && a[1] === "inspect"));\n  assert.ok(argv.every(a => !(a[0] === "volume" && a[1] === "create") && !(a[0] === "run" && a.some(v => v === "-v" || v === "--volume" || v.startsWith("--volume=") || v === "--mount" || v.startsWith("--mount="))) && !(a[0] === "compose" && a.some(v => v === "up" || v === "create"))));\n});\n\ntest("stable store ID refuses`;
  let text = original;
  for (const [before, after] of [[start, shell], [label, activate], [end, check]]) {
    ensure(text.split(before).length === 2, 'volume-test instrumentation must match once');
    text = text.replace(before, () => after);
  }
  const output = join(dir, 'server/deploy/test/issue-920-volume.test.mjs');
  writeFileSync(output, text);
  ensure(readFileSync(output, 'utf8') === text, 'volume test copy mismatch');
  console.log(JSON.stringify({case:'volume-test-copy', path:output, originalSha256:hash(original), copySha256:hash(text)}));
  return output;
}
