// Run against a built release and two built runner trees in an isolated test slot.
// The observer only records actual launches/exits; it never supplies a launcher.
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { observeSupervisor } from '../../../scripts/codex-backend-compatibility.mjs';

const [releaseArg, currentArg, oldArg] = process.argv.slice(2);
assert.ok(releaseArg && currentArg && oldArg, 'release executable, current tree, old tree required');
const release = resolve(releaseArg), current = resolve(currentArg), old = resolve(oldArg);
const root = await mkdtemp(join(tmpdir(), 'kogane910-native-'));
const exec = promisify(execFile), delay = ms => new Promise(r => setTimeout(r, ms));
const report = { builds: {}, observations: [], turns: [], controls: [], processes: [] };
const children = [], launched = [], logs = new Map(), recordedLogs = new Map();
let provider, server, providerRequests = 0, toolResults = 0;
const env = { PATH: dirname(process.execPath) + ':/usr/local/bin:/usr/bin:/bin', HOME: root, TMPDIR: root,
  ERL_FLAGS: '+S 3:3', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', RELEASE_NODE: 'kogane910@127.0.0.1', RELEASE_DISTRIBUTION: 'name',
  RELEASE_COOKIE: 'isolated-observation-test', PHX_SERVER: 'true', PORT: '44019', KAOIRO_RUNNER_TOKENS: 'observation-current:isolated-current,observation-old:isolated-old' };
async function waitFor(f, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await f(); if (value) return value; await delay(50); }
  throw new Error('timeout: ' + label);
}
function start(command, args, extra = {}) {
  const child = spawn(command, args, { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); logs.set(child, ''); recordedLogs.set(child, []);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { logs.set(child, (logs.get(child) + b).slice(-12000)); recordedLogs.get(child).push({ text: String(b), timestamp: Date.now() * 1000 }); });
  child.on('error', e => logs.set(child, logs.get(child) + e.message));
  return child;
}
async function rpc(expression) {
  const { stdout } = await exec(release, ['rpc', 'IO.puts(Jason.encode!(' + expression + '))'], { env, timeout: 12_000 });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}
const json = value => `Jason.decode!(${JSON.stringify(JSON.stringify(value))})`;
const observe = host => rpc(`case KaoiroServer.CodexBackendCompatibility.observe_runner(${JSON.stringify(host)}) do {:ok, p} -> p; {:error, e} -> %{error: to_string(e)} end`);
const broadcast = (topic, event, payload) => rpc(`KaoiroServerWeb.Endpoint.broadcast(${JSON.stringify(topic)}, ${JSON.stringify(event)}, ${json(payload)})`);
async function records() {
  const path = join(root, 'processes.jsonl');
  return existsSync(path) ? (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}
async function stopOwned(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  assert.ok(Number.isInteger(child.pid) && child.pid > 0);
  child.kill('SIGTERM');
  try { await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'owned process exit', 20_000); }
  catch { child.kill('SIGKILL'); await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'owned process kill'); }
}
try {
  await writeFile(join(root, 'observer.mjs'), `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {createHash} from 'node:crypto';
const log=x=>fs.appendFileSync(process.env.KOGANE_OBSERVATION_LOG,JSON.stringify(x)+'\\n');
log({kind:'node',pid:process.pid,ppid:process.ppid,entry:process.argv[1]});
const original=cp.spawn;cp.spawn=function(ex,args,opts){const p=original.apply(this,arguments);if(ex.endsWith('/codex'))log({kind:'native',pid:p.pid,sha:createHash('sha256').update(fs.readFileSync(ex)).digest('hex')});p.once('exit',(code,signal)=>log({kind:'exit',pid:p.pid,code,signal}));return p;};syncBuiltinESMExports();\n`);
  provider = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const payload = JSON.parse(raw), n = ++providerRequests, id = 'observation-' + n;
    if (JSON.stringify(payload.input).includes('OBSERVATION_TOOL_OK')) toolResults++;
    const output = n % 2 ? [{ type: 'custom_tool_call', id, call_id: id, name: 'exec', status: 'completed',
      input: 'text(await tools.exec_command({cmd:"printf OBSERVATION_TOOL_OK"}));' }]
      : [{ type: 'message', id, role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: 'Observation done', annotations: [] }] }];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [{ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
      ...output.flatMap((item, output_index) => [{ type: 'response.output_item.added', output_index, item }, { type: 'response.output_item.done', output_index, item }]),
      { type: 'response.completed', response: { id, object: 'response', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    res.end();
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  server = start(release, ['start']);
  await waitFor(async () => { try { return await rpc('true'); } catch { return false; } }, 'release ready');
  report.server_ready = true;
  for (const [label, tree] of [['current', current], ['old', old]]) {
    const host = 'observation-' + label, agent = host + '.existing', state = join(root, label);
    for (const directory of ['home', 'config', 'codex', 'work', 'tmp']) await mkdir(join(state, directory), { recursive: true });
    await writeFile(join(state, 'codex/config.toml'), `model = "gpt-6-luna"\nmodel_provider = "local"\n[model_providers.local]\nname = "Isolated observation"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\n[features]\nshell_snapshot = false\nplugins = false\n[analytics]\nenabled = false\n`);
    await writeFile(join(state, 'config/runner.config.json'), JSON.stringify({ host_id: host, server_url: 'ws://127.0.0.1:44019/runner',
      cwd_allowlist: [join(state, 'work')], capabilities: ['codex'], codex: { auth_mode: 'apikey', internal_subagents: false } }));
    const runnerEnv = { KAOIRO_RUNNER_TOKEN: 'isolated-' + label, HOME: join(state, 'home'), TMPDIR: join(state, 'tmp'),
      KAOIRO_NODE: process.execPath, KAOIRO_RUNNER_DIR: join(state, 'config'), CODEX_HOME: join(state, 'codex'),
      NODE_OPTIONS: '--import=' + join(root, 'observer.mjs'), KOGANE_OBSERVATION_LOG: join(root, 'processes.jsonl') };
    const runner = start(join(tree, 'runner/deploy/kaoiro-runner-launch.sh'), [], runnerEnv);
    await waitFor(async () => await rpc(`KaoiroServer.HostRegistry.get(${JSON.stringify(host)}) != nil`), 'runner registered');
    const build = JSON.parse(await readFile(join(tree, 'runner/dist/build-info.json'), 'utf8'));
    assert.equal(build.dirty, false);
    report.builds[label] = { revision: build.revision, dirty: build.dirty };
    if (label === 'old') assert.equal(build.revision, 'c8f75a35be90f683983db9857d32fc9276bd0f53');
    if (label === 'current') {
      const empty = await observe(host);
      assert.equal(empty.pid, runner.pid); assert.equal(empty.build_revision, build.revision);
      assert.deepEqual(empty.children, []); assert.equal(empty.applied_backend, 'exec');
      report.observations.push({ label, stage: 'empty', value: empty });
    }
    const initialTools = toolResults;
    launched.push({ host, agent });
    await broadcast('runner:' + host, 'spawn', { version: '0', agent_id: agent, persona: { id: 'ao', name: 'Ao', sprite_set: 'ao' },
      cwd: join(state, 'work'), engine: 'codex', model: 'gpt-6-luna', sandbox: 'danger-full-access', network_access: true,
      approval: 'never', initial_prompt: 'Perform the local tool turn.' });
    await waitFor(() => toolResults > initialTools, 'native tool result');
    const pointer = await waitFor(() => rpc(`case KaoiroServer.SessionPointers.get(${JSON.stringify(agent)}) do nil -> nil; p -> p.session_id end`), 'session pointer');
    const processes = await records(), wrapper = processes.find(x => x.kind === 'node' && x.ppid === runner.pid && x.entry.endsWith('/wrapper/codex/dist/cli.js'));
    assert.ok(wrapper?.pid > 0);
    const connected = await rpc(`MapSet.member?(KaoiroServer.AgentStates.connected_ids(), ${JSON.stringify(agent)})`);
    assert.equal(connected, true);
    const before = await rpc(`inspect(KaoiroServer.HostRegistry.get(${JSON.stringify(host)}).runner_pid)`);
    const started = Date.now(), value = await observe(host), elapsed = Date.now() - started;
    if (label === 'current') {
      assert.equal(value.pid, runner.pid);
      assert.deepEqual(value.children, [{ agent_id: agent, stopping: false, restarting: false, reset_pending: false }]);
      assert.deepEqual(value.pending_spawns, []); assert.deepEqual(value.pending_switches, []);
      assert.equal(value.applied_backend, 'exec');
    } else {
      assert.equal(value.error, 'runner_observation_timeout'); assert.ok(elapsed >= 5000);
    }
    report.observations.push({ label, stage: 'live', elapsed_ms: elapsed, value });
    // Systemd is not present in this slot. Its identity envelope is a declared
    // fixture; RPC, runner stdout, config and wrapper/native are actual products.
    const invocation = '1'.repeat(32);
    const readerCommand = (command, args) => {
      if (command === 'systemctl') return args.includes('MainPID') ? String(runner.pid) : invocation;
      if (command === 'journalctl' && args.includes('--output=cat')) return logs.get(runner);
      if (command === 'journalctl') return recordedLogs.get(runner).flatMap(({ text, timestamp }) =>
        text.split('\n').filter(line => /^codex: backend=|^runner: codex backend=/.test(line)).map(MESSAGE =>
          JSON.stringify({ MESSAGE, __REALTIME_TIMESTAMP: timestamp, _PID: wrapper.pid }))).join('\n');
      assert.equal(command, 'docker');
      return execFileSync(release, ['rpc', args.at(-1)], { env, timeout: 12_000, encoding: 'utf8' });
    };
    const readerArgs = { host, runner_config: join(state, 'config/runner.config.json'), runner_unit: 'fixture.service', compose_file: 'fixture.yml' };
    if (label === 'current') assert.equal((await observeSupervisor(readerArgs, readerCommand)).children[0].agent_id, agent);
    else await assert.rejects(observeSupervisor(readerArgs, readerCommand), /supervisor-observation-unavailable/);
    report.controls.push({ label, reader: label === 'current' ? 'live-entry' : 'timeout-refused', systemd_identity: 'declared-fixture', rpc: 'actual-release' });

    assert.equal(await rpc(`inspect(KaoiroServer.HostRegistry.get(${JSON.stringify(host)}).runner_pid)`), before);
    assert.equal(runner.exitCode, null); assert.equal(runner.signalCode, null);
    assert.ok(existsSync('/proc/' + wrapper.pid));
    const nextTools = toolResults;
    await broadcast('wrapper:' + agent, 'instruction', { version: '0', text: 'Perform another local tool turn.', delivery_intent: 'normal' });
    await waitFor(() => toolResults > nextTools, 'continued native tool turn');
    assert.equal(await rpc(`case KaoiroServer.SessionPointers.get(${JSON.stringify(agent)}) do nil -> nil; p -> p.session_id end`), pointer);
    report.turns.push({ label, runner_pid: runner.pid, wrapper_pid: wrapper.pid, same_session: true, tool_turns: 2 });
    if (label === 'current') {
      const extraRunner = start(join(tree, 'runner/deploy/kaoiro-runner-launch.sh'), [], runnerEnv);
      await waitFor(async () => (await rpc(`length(Registry.lookup(KaoiroServer.RunnerConnections.Registry, ${JSON.stringify(host)}))`)) === 2, 'duplicate joined');
      await waitFor(async () => (await rpc(`inspect(KaoiroServer.HostRegistry.get(${JSON.stringify(host)}).runner_pid)`)) !== before, 'empty runner becomes owner');
      assert.deepEqual(await observe(host), { error: 'ambiguous_runner' });
      assert.ok(existsSync('/proc/' + wrapper.pid));
      await assert.rejects(observeSupervisor(readerArgs, readerCommand), /supervisor-observation-unavailable/);
      report.controls.push({ label, duplicate_join: 'refused', non_owner_has_live_child: true, owner_has_no_child: true });
      await stopOwned(extraRunner);
      await waitFor(async () => (await rpc(`length(Registry.lookup(KaoiroServer.RunnerConnections.Registry, ${JSON.stringify(host)}))`)) === 1, 'duplicate removed');
      // Reopen only this test's transport: registration runs on socket open, not channel rejoin.
      await rpc(`(fn -> [{pid, nil}] = Registry.lookup(KaoiroServer.RunnerConnections.Registry, ${JSON.stringify(host)}); Process.exit(:sys.get_state(pid).transport_pid, :kill); true end).()`);
      await waitFor(async () => await rpc(`KaoiroServer.HostRegistry.get(${JSON.stringify(host)}) != nil`), 'owner reregistered');
      assert.equal((await observe(host)).children[0].agent_id, agent);
      assert.ok(existsSync('/proc/' + wrapper.pid));
      for (const reason of ['normal', 'kill']) {
        await rpc(`(fn -> [{_, partition, :worker, [Registry.Partition]}] = Supervisor.which_children(KaoiroServer.RunnerConnections.Registry); ${reason === 'normal' ? 'GenServer.stop(partition, :normal)' : 'Process.exit(partition, :kill)'}; true end).()`);
        assert.deepEqual(await observe(host), { error: 'runner_registry_changed' });
        assert.equal(await rpc(`MapSet.member?(KaoiroServer.AgentStates.connected_ids(), ${JSON.stringify(agent)})`), true);
        assert.ok(existsSync('/proc/' + wrapper.pid));
        await rpc('(fn -> :ok = Application.stop(:kaoiro_server); {:ok, _} = Application.ensure_all_started(:kaoiro_server); true end).()');
        await waitFor(async () => await rpc(`KaoiroServer.HostRegistry.get(${JSON.stringify(host)}) != nil`), 'registration after whole application restart');
        await waitFor(() => rpc(`MapSet.member?(KaoiroServer.AgentStates.connected_ids(), ${JSON.stringify(agent)})`), 'wrapper reconnected after application restart');
        assert.equal((await observe(host)).children[0].agent_id, agent);
        assert.ok(existsSync('/proc/' + wrapper.pid));
        report.controls.push({ label, partition_exit: reason, wrapper_unaffected_by_partition: true, whole_application_restart_recovered: true });
      }
    }

    await broadcast('runner:' + host, 'stop', { version: '0', agent_id: agent });
    await waitFor(() => !existsSync('/proc/' + wrapper.pid), 'wrapper exited');
    await waitFor(async () => !(await rpc(`MapSet.member?(KaoiroServer.AgentStates.connected_ids(), ${JSON.stringify(agent)})`)), 'server disconnected');
    if (label === 'current') {
      assert.deepEqual((await observe(host)).children, []);
      await delay(10_050);
      const after = await observe(host); assert.deepEqual(after.children, []);
      assert.equal((await records()).filter(x => x.kind === 'node' && x.ppid === runner.pid && x.entry.endsWith('/wrapper/codex/dist/cli.js')).length, 1);
      report.observations.push({ label, stage: 'after-exit-and-timer-boundary', value: after });
    }
    report.controls.push({ label, stop: true, wrapper_exited: true, server_disconnected: true });
    await stopOwned(runner);
  }
  report.processes = await records();
  assert.ok(report.processes.filter(x => x.kind === 'native').length >= 4);
  report.result = 'pass';
} catch (error) {
  report.result = 'fail'; report.error = error.stack;
  report.logs = children.map(child => ({ pid: child.pid, exit: child.exitCode, tail: logs.get(child) }));
} finally {
  for (const { host, agent } of launched) {
    try { await broadcast('runner:' + host, 'stop', { version: '0', agent_id: agent }); }
    catch (error) { report.cleanup_error = error.message; }
  }
  try { await waitFor(async () => (await records()).filter(x => x.kind === 'node' && x.entry.endsWith('/wrapper/codex/dist/cli.js')).every(x => !existsSync('/proc/' + x.pid)), 'owned wrappers stopped', 15_000); }
  catch (error) { report.cleanup_error = error.message; }
  for (const child of [...children].reverse()) await stopOwned(child);
  if (provider) { provider.closeAllConnections(); await new Promise(r => provider.close(r)); }
  report.processes = await records();
  report.all_observed_processes_gone = report.processes.filter(x => x.kind === 'node' || x.kind === 'native').every(x => !existsSync('/proc/' + x.pid));
  await rm(root, { recursive: true, force: true });
  report.scratch_removed = !existsSync(root);
  console.log(JSON.stringify(report));
}
assert.equal(report.result, 'pass');
assert.equal(report.all_observed_processes_gone, true);
