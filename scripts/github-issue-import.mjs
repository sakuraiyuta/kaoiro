#!/usr/bin/env node
/**
 * Import a reviewed, local Gitea issue bundle into GitHub.
 *
 * The script deliberately does not fetch from Gitea: its inputs are the
 * content-frozen bundle, the approved issue list, and the redaction map.
 */
import { appendFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ATTACHMENT_PATTERN = /https?:\/\/[^\s)\]"']*\/attachments\/[^\s)\]"']*/g;
const PLACEHOLDER = '[attachment omitted; see migration attachments manifest]';

function fail(message) { throw new Error(message); }
function usage() {
  console.error(`Usage: github-issue-import.mjs --repo OWNER/REPO --issues-glob GLOB --comments-glob GLOB --issue-list FILE --redact-map FILE --state-dir DIR --attachments-output FILE [--canary-list FILE] [--map-output FILE] [--canary N] [--dry-run]\n\nInput JSON:\n  issue list: [12, 34]\n  redact map: [{"kind":"literal","pattern":"old","replacement":"new"}, {"kind":"regex","pattern":"...","replacement":"...","flags":"gi"}]`);
  process.exit(2);
}
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) usage();
    const name = key.slice(2);
    if (name === 'dry-run') { out.dryRun = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) usage();
    out[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  for (const name of ['repo', 'issuesGlob', 'commentsGlob', 'issueList', 'redactMap', 'stateDir', 'attachmentsOutput']) if (!out[name]) usage();
  if (out.canary && (!Number.isInteger(Number(out.canary)) || Number(out.canary) < 1)) fail('--canary must be a positive integer');
  return out;
}
function glob(pattern) {
  const dir = dirname(pattern); const base = basename(pattern);
  const regex = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*')}$`);
  if (!existsSync(dir)) fail(`bundle directory does not exist: ${dir}`);
  const files = readdirSync(dir).filter((x) => regex.test(x)).sort().map((x) => join(dir, x));
  if (!files.length) fail(`glob matched no files: ${pattern}`);
  return files;
}
function json(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { fail(`invalid JSON in ${path}: ${e.message}`); } }
function arrayBundle(pattern, label) {
  return glob(pattern).flatMap((path) => { const v = json(path); if (!Array.isArray(v)) fail(`${label} bundle is not an array: ${path}`); return v; });
}
function selectedNumbers(path, canary) {
  const value = json(path); const list = Array.isArray(value) ? value : value.issues;
  if (!Array.isArray(list) || !list.every((n) => Number.isInteger(n) && n > 0)) fail(`issue list must be a JSON array of positive integers: ${path}`);
  if (new Set(list).size !== list.length) fail(`issue list has duplicate numbers: ${path}`);
  return canary ? list.slice(0, Number(canary)) : list;
}
function redactRules(path) {
  const rules = json(path);
  if (!Array.isArray(rules)) fail(`redact map must be a JSON array: ${path}`);
  return rules.map((r, index) => {
    if (!r || !['literal', 'regex'].includes(r.kind) || typeof r.pattern !== 'string' || typeof r.replacement !== 'string') fail(`invalid redact rule at index ${index}`);
    if (r.kind === 'regex') {
      if (r.flags !== undefined && (typeof r.flags !== 'string' || /[^dgimsuvy]/.test(r.flags))) fail(`invalid regex flags at index ${index}`);
      try { new RegExp(r.pattern, r.flags ?? 'g'); } catch (e) { fail(`invalid regex at index ${index}: ${e.message}`); }
    } else if (r.flags !== undefined) fail(`literal redact rule must not have flags at index ${index}`);
    return r;
  });
}
function redact(text, rules) {
  return rules.reduce((result, r) => r.kind === 'literal'
    ? result.split(r.pattern).join(r.replacement)
    : result.replace(new RegExp(r.pattern, r.flags?.includes('g') ? r.flags : `${r.flags ?? ''}g`), r.replacement), String(text ?? ''));
}
function attachmentUrls(text) { return String(text ?? '').match(ATTACHMENT_PATTERN) ?? []; }
function prepareText(text, attachmentRows, oldNumber, commentId = null) {
  const raw = String(text ?? '');
  const urls = attachmentUrls(raw);
  for (const url of urls) attachmentRows.push({ old_issue: oldNumber, source_comment_id: commentId, url });
  let index = 0;
  const shielded = raw.replace(ATTACHMENT_PATTERN, () => `\u0000KAOIRO_ATTACHMENT_${index++}\u0000`);
  return shielded;
}
function sanitizeText(text, rules) { return redact(text, rules).replace(/\u0000KAOIRO_ATTACHMENT_\d+\u0000/g, PLACEHOLDER); }
function issueNumberFromComment(comment) {
  const match = String(comment.issue_url ?? '').match(/\/issues\/(\d+)(?:$|[?#])/);
  if (!match) fail(`comment ${comment.id ?? '(unknown)'} has no parseable issue_url`);
  return Number(match[1]);
}
function appendJournal(path, event) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a');
  try { appendFileSync(fd, `${JSON.stringify(event)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}
function journal(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line, i) => { try { return JSON.parse(line); } catch { fail(`invalid journal line ${i + 1}: ${path}`); } });
}
function latest(events, predicate) { return events.filter(predicate).at(-1); }
function writeJson(path, value) { mkdirSync(dirname(resolve(path)), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function gh(args, input) {
  const result = spawnSync(process.env.GH_BIN || 'gh', ['api', ...args], { input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8' });
  if (result.error) fail(`could not run gh: ${result.error.message}`);
  if (result.status !== 0) fail(`gh api failed (${args.join(' ')}): ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout;
}
function parseValues(text) {
  const values = []; let rest = text.trim();
  while (rest) {
    let end = 1; let parsed;
    for (; end <= rest.length; end++) { try { parsed = JSON.parse(rest.slice(0, end)); break; } catch {} }
    if (parsed === undefined) fail('gh returned invalid JSON');
    values.push(parsed); rest = rest.slice(end).trim();
  }
  return values.flatMap((x) => Array.isArray(x) ? x : [x]);
}
function ghJson(args, input) { const values = parseValues(gh(args, input)); return values.length === 1 ? values[0] : values; }
function ghList(endpoint) { return parseValues(gh(['--paginate', endpoint])); }
function encodedRepo(repo) { if (!/^[^/]+\/[^/]+$/.test(repo)) fail('--repo must be OWNER/REPO'); return repo.split('/').map(encodeURIComponent).join('/'); }

function sourceData(options) {
  const allMigrated = selectedNumbers(options.issueList);
  let numbers = allMigrated;
  if (options.canaryList) {
    numbers = selectedNumbers(options.canaryList);
    const allSet = new Set(allMigrated);
    if (!numbers.every((n) => allSet.has(n))) fail('--canary-list contains a number outside --issue-list');
  }
  if (options.canary) numbers = numbers.slice(0, Number(options.canary));
  const byNumber = new Map();
  const sourceIssues = arrayBundle(options.issuesGlob, 'issues');
  for (const issue of sourceIssues) {
    if (!Number.isInteger(issue.number)) fail('issue bundle contains an issue without an integer number');
    if (byNumber.has(issue.number)) fail(`issue bundle duplicates issue ${issue.number}`);
    byNumber.set(issue.number, issue);
  }
  const issues = numbers.map((n) => { const issue = byNumber.get(n); if (!issue) fail(`selected issue ${n} is missing from bundle`); return issue; });
  const chosen = new Set(numbers); const comments = new Map(numbers.map((n) => [n, []]));
  for (const comment of arrayBundle(options.commentsGlob, 'comments')) {
    const n = issueNumberFromComment(comment);
    if (chosen.has(n)) comments.get(n).push(comment);
  }
  for (const [n, values] of comments) values.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || Number(a.id) - Number(b.id));
  return { numbers, issues, comments, sourceIssues, allMigratedNumbers: new Set(allMigrated) };
}
function migrationFooter(issue) { return `\n\nMigrated from private Gitea issue ${issue.number} (originally created at ${issue.created_at})`; }
function commentFooter(issue, comment) { return `\n\nMigrated comment from private Gitea issue ${issue.number} (originally created at ${comment.created_at})\n<!-- kaoiro-gitea-comment:${comment.id} -->`; }
function localReferenceRewrite(text, sourceIssues, allMigratedNumbers, map, repo) {
  let output = text;
  for (const issue of sourceIssues) {
    const target = map[String(issue.number)];
    const replacement = target ? `https://github.com/${repo}/issues/${target}` : `private Gitea issue ${issue.number} (${allMigratedNumbers.has(issue.number) ? 'migration pending' : 'not migrated'})`;
    for (const url of [issue.html_url, issue.url].filter(Boolean)) output = output.split(String(url)).join(replacement);
  }
  const sourceNumbers = new Set(sourceIssues.map((issue) => String(issue.number)));
  return output.replace(/(^|[^\w])#(\d+)\b/g, (all, before, n) => {
    if (map[n]) return `${before}#${map[n]}`;
    return sourceNumbers.has(n) ? `${before}private Gitea issue ${n} (${allMigratedNumbers.has(Number(n)) ? 'migration pending' : 'not migrated'})` : all;
  });
}
function ensureMetadata(repo, issues, report) {
  const r = encodedRepo(repo);
  const labels = ghList(`repos/${r}/labels?per_page=100`);
  const labelByName = new Map(labels.map((x) => [x.name, x]));
  const requiredLabels = new Map();
  for (const issue of issues) for (const label of issue.labels ?? []) requiredLabels.set(label.name, label);
  for (const [name, source] of requiredLabels) {
    const existing = labelByName.get(name);
    if (!existing) {
      const color = String(source.color ?? 'ededed').replace(/^#/, '');
      const created = ghJson(['-X', 'POST', `repos/${r}/labels`, '--input', '-'], { name, color, description: source.description ?? '' });
      labelByName.set(name, created);
    } else if (String(existing.color ?? '').replace(/^#/, '').toLowerCase() !== String(source.color ?? '').replace(/^#/, '').toLowerCase() || (existing.description ?? '') !== (source.description ?? '')) {
      report.metadata_warnings.push({ kind: 'label_mismatch', name, source: { color: source.color ?? '', description: source.description ?? '' }, target: { color: existing.color ?? '', description: existing.description ?? '' } });
    }
  }
  const milestones = ghList(`repos/${r}/milestones?state=all&per_page=100`);
  const milestoneByTitle = new Map(milestones.map((x) => [x.title, x]));
  for (const source of issues.map((x) => x.milestone).filter(Boolean)) {
    const existing = milestoneByTitle.get(source.title);
    if (!existing) {
      const body = { title: source.title };
      if (source.description) body.description = source.description;
      if (source.due_on) body.due_on = source.due_on;
      const created = ghJson(['-X', 'POST', `repos/${r}/milestones`, '--input', '-'], body);
      milestoneByTitle.set(source.title, created);
    } else if ((existing.description ?? '') !== (source.description ?? '') || (existing.due_on ?? null) !== (source.due_on ?? null)) {
      report.metadata_warnings.push({ kind: 'milestone_mismatch', title: source.title });
    }
  }
  return milestoneByTitle;
}
function findMigratedIssue(repo, oldNumber) {
  const q = encodeURIComponent(`repo:${repo} is:issue in:body "Migrated from private Gitea issue ${oldNumber}"`);
  const result = ghJson([`search/issues?q=${q}`]);
  const matches = (result.items ?? []).filter((x) => String(x.body ?? '').includes(`Migrated from private Gitea issue ${oldNumber}`));
  if (matches.length > 1) fail(`multiple GitHub issues match source issue ${oldNumber}; resolve before retrying`);
  return matches[0] ?? null;
}
function findMigratedComment(repo, newNumber, sourceCommentId) {
  const comments = ghList(`repos/${encodedRepo(repo)}/issues/${newNumber}/comments?per_page=100`);
  const marker = `<!-- kaoiro-gitea-comment:${sourceCommentId} -->`;
  const matches = comments.filter((x) => String(x.body ?? '').includes(marker));
  if (matches.length > 1) fail(`multiple GitHub comments match source comment ${sourceCommentId}; resolve before retrying`);
  return matches[0] ?? null;
}
function main() {
  const options = args(process.argv.slice(2));
  const data = sourceData(options); const rules = redactRules(options.redactMap);
  const stateDir = resolve(options.stateDir); const journalPath = join(stateDir, 'journal.jsonl'); const mapPath = options.mapOutput ?? join(stateDir, 'old-to-new.json');
  const attachments = []; const report = { repo: options.repo, dry_run: Boolean(options.dryRun), selected_old_numbers: data.numbers, metadata_warnings: [], created: [], reused: [], planned: [], attachments_output: resolve(options.attachmentsOutput) };
  const preparedIssues = new Map(data.issues.map((issue) => [issue.number, { title: redact(issue.title, rules), body: prepareText(issue.body, attachments, issue.number) }]));
  const preparedComments = new Map(data.numbers.map((n) => [n, data.comments.get(n).map((comment) => ({ source: comment, body: prepareText(comment.body, attachments, n, comment.id) }))]));
  writeJson(options.attachmentsOutput, attachments);
  if (options.dryRun) {
    report.planned = data.numbers.map((n) => ({ old_number: n, title: preparedIssues.get(n).title, comments: preparedComments.get(n).length }));
    writeJson(join(stateDir, 'dry-run-report.json'), report);
    console.log(`dry-run: ${data.numbers.length} issues, ${[...preparedComments.values()].flat().length} comments, ${attachments.length} attachment references`);
    return;
  }
  const milestones = ensureMetadata(options.repo, data.issues, report);
  const events = journal(journalPath); const map = {};
  for (const event of events) if (event.kind === 'issue_created') map[String(event.old_number)] = event.new_number;
  for (const issue of data.issues) {
    const old = issue.number; const prior = latest(events, (x) => x.kind === 'issue_creating' && x.old_number === old); const complete = map[String(old)];
    if (complete) { report.reused.push({ old_number: old, new_number: complete, source: 'journal' }); continue; }
    if (prior) fail(`source issue ${old} has a pending creation journal entry; inspect GitHub and journal before retrying`);
    const found = findMigratedIssue(options.repo, old);
    if (found) { appendJournal(journalPath, { kind: 'issue_created', old_number: old, new_number: found.number, source: 'search', at: new Date().toISOString() }); map[String(old)] = found.number; report.reused.push({ old_number: old, new_number: found.number, source: 'search' }); continue; }
    appendJournal(journalPath, { kind: 'issue_creating', old_number: old, at: new Date().toISOString() });
    const item = preparedIssues.get(old); const payload = { title: item.title, body: `${sanitizeText(item.body, rules)}${migrationFooter(issue)}`, labels: (issue.labels ?? []).map((x) => x.name) };
    if (issue.milestone) payload.milestone = milestones.get(issue.milestone.title).number;
    const created = ghJson(['-X', 'POST', `repos/${encodedRepo(options.repo)}/issues`, '--input', '-'], payload);
    if (!Number.isInteger(created.number)) fail(`GitHub create issue response had no number for source issue ${old}`);
    appendJournal(journalPath, { kind: 'issue_created', old_number: old, new_number: created.number, at: new Date().toISOString() }); map[String(old)] = created.number; report.created.push({ old_number: old, new_number: created.number });
  }
  writeJson(mapPath, map);
  for (const issue of data.issues) {
    const old = issue.number; const target = map[String(old)];
    for (const comment of preparedComments.get(old)) {
      const id = comment.source.id; const current = journal(journalPath); const created = latest(current, (x) => x.kind === 'comment_created' && x.old_issue === old && x.source_comment_id === id);
      if (created) continue;
      if (latest(current, (x) => x.kind === 'comment_creating' && x.old_issue === old && x.source_comment_id === id)) fail(`source comment ${id} has a pending creation journal entry; inspect GitHub and journal before retrying`);
      const found = findMigratedComment(options.repo, target, id);
      if (found) { appendJournal(journalPath, { kind: 'comment_created', old_issue: old, source_comment_id: id, github_comment_id: found.id, at: new Date().toISOString() }); continue; }
      appendJournal(journalPath, { kind: 'comment_creating', old_issue: old, source_comment_id: id, at: new Date().toISOString() });
      const createdComment = ghJson(['-X', 'POST', `repos/${encodedRepo(options.repo)}/issues/${target}/comments`, '--input', '-'], { body: `${sanitizeText(comment.body, rules)}${commentFooter(issue, comment.source)}` });
      appendJournal(journalPath, { kind: 'comment_created', old_issue: old, source_comment_id: id, github_comment_id: createdComment.id, at: new Date().toISOString() });
    }
  }
  for (const issue of data.issues) {
    const target = map[String(issue.number)]; const body = `${sanitizeText(localReferenceRewrite(preparedIssues.get(issue.number).body, data.sourceIssues, data.allMigratedNumbers, map, options.repo), rules)}${migrationFooter(issue)}`;
    ghJson(['-X', 'PATCH', `repos/${encodedRepo(options.repo)}/issues/${target}`, '--input', '-'], { body });
    for (const comment of preparedComments.get(issue.number)) {
      const created = latest(journal(journalPath), (x) => x.kind === 'comment_created' && x.old_issue === issue.number && x.source_comment_id === comment.source.id);
      const commentBody = `${sanitizeText(localReferenceRewrite(comment.body, data.sourceIssues, data.allMigratedNumbers, map, options.repo), rules)}${commentFooter(issue, comment.source)}`;
      ghJson(['-X', 'PATCH', `repos/${encodedRepo(options.repo)}/issues/comments/${created.github_comment_id}`, '--input', '-'], { body: commentBody });
    }
    if (issue.state === 'closed') ghJson(['-X', 'PATCH', `repos/${encodedRepo(options.repo)}/issues/${target}`, '--input', '-'], { state: 'closed' });
  }
  writeJson(join(stateDir, 'import-report.json'), report);
  console.log(`imported/reused ${data.numbers.length} issues; map: ${mapPath}; attachments: ${options.attachmentsOutput}`);
}

main();
