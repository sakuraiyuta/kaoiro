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
    const recovery = report.controls.filter(row => row.partition_exit);
    const last = recovery.at(-1);
    if (name === 'vm-restart-omitted') {
      assert.equal(last.old_vm_pid, last.new_vm_pid);
      assert.deepEqual(last.recovered, { error: 'runner_registry_changed' });
    } else if (name === 'application-only') {
      assert.equal(recovery[0].partition_exit, 'normal');
      assert.equal(recovery[0].recovered.error, undefined);
      assert.equal(recovery[0].old_vm_pid, recovery[0].new_vm_pid);
      assert.equal(last.partition_exit, 'kill');
      assert.equal(last.old_vm_pid, last.new_vm_pid);
      assert.ok(last.registrations.length > 1);
      assert.ok(last.registrations.every(value => value === false));
      assert.deepEqual(last.observed_after_timeout, { error: 'ambiguous_runner' });
    } else {
      assert.equal(name, 'registration-wait-omitted');
      assert.deepEqual(last.registrations, []);
      assert.deepEqual(last.recovered, { error: 'ambiguous_runner' });
    }
  } else {
    assert.equal(result.status, 0);
    assert.equal(report.result, 'pass');
    const recovery = report.controls.filter(row => row.partition_exit);
    assert.deepEqual(recovery.map(row => row.partition_exit), ['normal', 'kill']);
    for (const row of recovery) {
      assert.equal(row.old_vm_exited, true);
      assert.equal(row.old_vm_absent, true);
      assert.notEqual(row.old_vm_pid, row.new_vm_pid);
      assert.deepEqual(row.immediate, { error: 'ambiguous_runner' });
      assert.equal(row.registrations[0], false);
      assert.equal(row.registrations.at(-1), true);
      assert.equal(row.recovered.error, undefined);
      assert.equal(row.wrapper_unaffected_by_partition, true);
    }
  }
}

const mutations = [
  ['vm-restart-omitted', 'await restartVm();', 'void restartVm;', 'recovery observation must succeed'],
  ['application-only', 'await restartVm();',
    "await rpc('(fn -> :ok = Application.stop(:kaoiro_server); {:ok, _} = Application.ensure_all_started(:kaoiro_server); true end).()');",
    'timeout: runner registration after recovery'],
  ['registration-wait-omitted', 'await waitForRegistration();',
    'void waitForRegistration;', 'recovery observation must succeed'],
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
