import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./codex-work-observation-native.mjs', import.meta.url));
const temporary = fixture.replace('.mjs', `.negative-${process.pid}.mjs`);
const original = readFileSync(fixture, 'utf8');
const args = process.argv.slice(2);
assert.equal(args.length, 3, 'release executable, current tree, old tree required');

function run(name, script, expectedError) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 300_000 });
  const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
  console.log(JSON.stringify({ name, exit: result.status, report, stderr: result.stderr }));
  assert.equal(result.error, undefined);
  assert.equal(report.all_observed_processes_gone, true, 'previous case must release its processes');
  assert.equal(report.scratch_removed, true, 'previous case must release its scratch');
  if (expectedError) {
    assert.equal(result.status, 1);
    assert.equal(report.result, 'fail');
    assert.ok(report.error.includes(expectedError), report.error);
  } else {
    assert.equal(result.status, 0);
    assert.equal(report.result, 'pass');
  }
}

const mutations = [
  ['vm-restart-omitted', 'await restartVm();', 'void restartVm;', 'recovery requires the old VM to exit'],
  ['application-only', 'await restartVm();',
    "await rpc('(fn -> :ok = Application.stop(:kaoiro_server); {:ok, _} = Application.ensure_all_started(:kaoiro_server); true end).()');",
    'recovery requires the old VM to exit'],
  ['registration-wait-omitted', "await waitFor(registrationReady, 'runner registration after VM restart');",
    'await registrationReady();', 'recovery must wait for runner registration'],
];

run('baseline', fixture);
writeFileSync(temporary, '', { flag: 'wx' });
try {
  for (const [name, from, to, error] of mutations) {
    assert.equal(original.split(from).length, 2, `unique mutation anchor: ${name}`);
    writeFileSync(temporary, original.replace(from, to));
    run(name, temporary, error);
  }
} finally {
  rmSync(temporary);
}
assert.equal(existsSync(temporary), false);
assert.equal(readFileSync(fixture, 'utf8'), original);
run('restored', fixture);
