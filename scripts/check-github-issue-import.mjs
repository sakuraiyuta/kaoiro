#!/usr/bin/env node
/** Verify content counts after github-issue-import.mjs has completed. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const PLACEHOLDER = '[attachment omitted; see migration attachments manifest]';
const ATTACHMENT_PATTERN = /https?:\/\/[^\s)\]"']*\/attachments\/[^\s)\]"']*/g;
function fail(message) { throw new Error(message); }
function usage() { console.error('Usage: check-github-issue-import.mjs --repo OWNER/REPO --issues-glob GLOB --comments-glob GLOB --issue-list FILE --map FILE --attachments FILE'); process.exit(2); }
function args(argv) { const out = {}; for (let i = 0; i < argv.length; i++) { const key = argv[i]; if (!key.startsWith('--')) usage(); const value = argv[++i]; if (!value || value.startsWith('--')) usage(); out[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value; } for (const key of ['repo', 'issuesGlob', 'commentsGlob', 'issueList', 'map', 'attachments']) if (!out[key]) usage(); return out; }
function glob(pattern) { const dir = dirname(pattern); const base = basename(pattern); const rx = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*')}$`); const files = existsSync(dir) ? readdirSync(dir).filter((x) => rx.test(x)).sort().map((x) => `${dir}/${x}`) : []; if (!files.length) fail(`glob matched no files: ${pattern}`); return files; }
function json(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { fail(`invalid JSON in ${path}: ${e.message}`); } }
function bundle(pattern) { return glob(pattern).flatMap((path) => { const v = json(path); if (!Array.isArray(v)) fail(`bundle is not an array: ${path}`); return v; }); }
function issueNumbers(path) { const v = json(path); const xs = Array.isArray(v) ? v : v.issues; if (!Array.isArray(xs) || !xs.every((x) => Number.isInteger(x) && x > 0)) fail(`invalid issue list: ${path}`); return xs; }
function issueOfComment(comment) { const m = String(comment.issue_url ?? '').match(/\/issues\/(\d+)(?:$|[?#])/); if (!m) fail(`comment ${comment.id ?? '(unknown)'} has no issue_url`); return Number(m[1]); }
function parseValues(text) { const out = []; let rest = text.trim(); while (rest) { let parsed; let end = 1; for (; end <= rest.length; end++) { try { parsed = JSON.parse(rest.slice(0, end)); break; } catch {} } if (parsed === undefined) fail('gh returned invalid JSON'); out.push(parsed); rest = rest.slice(end).trim(); } return out.flatMap((x) => Array.isArray(x) ? x : [x]); }
function gh(args) { const result = spawnSync(process.env.GH_BIN || 'gh', ['api', ...args], { encoding: 'utf8' }); if (result.error) fail(`could not run gh: ${result.error.message}`); if (result.status !== 0) fail(`gh api failed (${args.join(' ')}): ${result.stderr.trim() || result.stdout.trim()}`); return parseValues(result.stdout); }
function repo(repo) { if (!/^[^/]+\/[^/]+$/.test(repo)) fail('--repo must be OWNER/REPO'); return repo.split('/').map(encodeURIComponent).join('/'); }
function countAttachments(text) { return (String(text ?? '').match(ATTACHMENT_PATTERN) ?? []).length; }
function main() {
  const o = args(process.argv.slice(2)); const wanted = issueNumbers(o.issueList); const wantedSet = new Set(wanted); const map = json(o.map);
  if (!map || Array.isArray(map) || typeof map !== 'object') fail(`map must be an old-number-to-new-number JSON object: ${o.map}`);
  if (Object.keys(map).length !== wanted.length || !wanted.every((n) => Number.isInteger(map[String(n)]))) fail('map does not contain exactly the selected old issue numbers');
  const issues = new Map(bundle(o.issuesGlob).map((x) => [x.number, x]));
  if (!wanted.every((n) => issues.has(n))) fail('selected issue is missing from source bundle');
  const sourceComments = bundle(o.commentsGlob).filter((x) => wantedSet.has(issueOfComment(x)));
  const expectedComments = sourceComments.length;
  const expectedAttachmentRefs = wanted.reduce((count, n) => count + countAttachments(issues.get(n).body), 0)
    + sourceComments.reduce((count, comment) => count + countAttachments(comment.body), 0);
  const attachmentManifest = json(o.attachments); if (!Array.isArray(attachmentManifest)) fail(`attachments must be an array: ${o.attachments}`);
  if (attachmentManifest.length !== expectedAttachmentRefs) fail('attachment manifest count differs from source bundle attachment reference count');
  const r = repo(o.repo); let actualComments = 0; let actualPlaceholders = 0; const missing = [];
  for (const old of wanted) {
    const target = map[String(old)]; const issueValues = gh([`repos/${r}/issues/${target}`]); const targetIssue = issueValues[0];
    if (!targetIssue || !String(targetIssue.body ?? '').includes(`Migrated from private Gitea issue ${old}`)) { missing.push({ old, target, reason: 'missing migration footer' }); continue; }
    actualPlaceholders += String(targetIssue.body ?? '').split(PLACEHOLDER).length - 1;
    const comments = gh(['--paginate', `repos/${r}/issues/${target}/comments?per_page=100`]); actualComments += comments.length;
    for (const comment of comments) actualPlaceholders += String(comment.body ?? '').split(PLACEHOLDER).length - 1;
  }
  const actualIssues = wanted.length - missing.length;
  const result = { expected: { issues: wanted.length, comments: expectedComments, attachment_references: expectedAttachmentRefs }, actual: { issues: actualIssues, comments: actualComments, attachment_placeholders: actualPlaceholders }, missing };
  console.log(JSON.stringify(result, null, 2));
  if (missing.length || actualIssues !== wanted.length || actualComments !== expectedComments || actualPlaceholders !== expectedAttachmentRefs) process.exitCode = 1;
}
main();
