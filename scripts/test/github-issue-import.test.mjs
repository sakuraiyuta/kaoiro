import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const fixtures = join(root, 'scripts/test/fixtures/github-issue-import');
const importer = join(root, 'scripts/github-issue-import.mjs');
const checker = join(root, 'scripts/check-github-issue-import.mjs');
const mock = join(root, 'scripts/test/mock-github-api.mjs');
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'momo91-test-')); const state = join(dir, 'github.json');
  writeFileSync(state, JSON.stringify({ labels: [], milestones: [], issues: {}, comments: {}, nextIssue: 100, nextComment: 900 }));
  const env = { ...process.env, GH_BIN: mock, MOCK_GH_STATE: state };
  const base = ['--repo', 'acme/target', '--issues-glob', join(fixtures, 'issues-*.json'), '--comments-glob', join(fixtures, 'comments-*.json'), '--issue-list', join(fixtures, 'issues.json'), '--redact-map', join(fixtures, 'redact.json'), '--state-dir', join(dir, 'state'), '--attachments-output', join(dir, 'attachments.json')];
  return { dir, state, env, base };
}
function run(command, args, env) { return spawnSync(process.execPath, [command, ...args], { env, encoding: 'utf8' }); }
test('dry-run plans a canary without calling GitHub', () => {
  const x = setup(); try {
    const result = run(importer, [...x.base, '--canary', '1', '--dry-run'], x.env);
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /dry-run: 1 issues, 1 comments, 2 attachment references/);
    const state = JSON.parse(readFileSync(x.state)); assert.deepEqual(state.issues, {});
  } finally { rmSync(x.dir, { recursive: true, force: true }); }
});
test('imports, rewrites, closes, resumes, and conserves exact counts', () => {
  const x = setup(); try {
    let result = run(importer, x.base, x.env); assert.equal(result.status, 0, result.stderr);
    let state = JSON.parse(readFileSync(x.state)); assert.equal(Object.keys(state.issues).length, 2); assert.equal(state.comments[100].length + state.comments[101].length, 2);
    assert.match(state.issues[100].body, /#101/); assert.match(state.issues[101].body, /#100/); assert.match(state.issues[100].body, /private Gitea issue 9 \(not migrated\)/); assert.equal(state.issues[100].state, 'closed'); assert.doesNotMatch(state.issues[100].body, /SECRET|private\.example|gitea\.example\.invalid/);
    result = run(importer, x.base, x.env); assert.equal(result.status, 0, result.stderr);
    state = JSON.parse(readFileSync(x.state)); assert.equal(Object.keys(state.issues).length, 2); assert.equal(state.comments[100].length + state.comments[101].length, 2);
    const checkArgs = ['--repo', 'acme/target', '--issues-glob', join(fixtures, 'issues-*.json'), '--comments-glob', join(fixtures, 'comments-*.json'), '--issue-list', join(fixtures, 'issues.json'), '--map', join(x.dir, 'state/old-to-new.json'), '--attachments', join(x.dir, 'attachments.json')];
    result = run(checker, checkArgs, x.env); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /"attachment_placeholders": 2/);
    writeFileSync(join(x.dir, 'attachments.json'), '[]\n');
    result = run(checker, checkArgs, x.env); assert.notEqual(result.status, 0); assert.match(result.stderr, /manifest count differs/);
  } finally { rmSync(x.dir, { recursive: true, force: true }); }
});
test('a pending creation journal fails before creating a duplicate', () => {
  const x = setup(); try {
    const stateDir = join(x.dir, 'state');
    mkdirSync(stateDir); writeFileSync(join(stateDir, 'journal.jsonl'), '{"kind":"issue_creating","old_number":7}\n');
    const result = run(importer, x.base, x.env); assert.notEqual(result.status, 0); assert.match(result.stderr, /pending creation journal entry/);
    const state = JSON.parse(readFileSync(x.state)); assert.deepEqual(state.issues, {});
  } finally { rmSync(x.dir, { recursive: true, force: true }); }
});
