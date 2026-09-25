---
title: Pre-turn account rate-limit probes
status: measured
last_updated: 2026-09-26
---

# Pre-turn account rate-limit probes

Issue [#408](https://github.com/sakuraiyuta/kaoiro/issues/408). The initial
account probes ran on 2026-09-25 16:55–16:57 UTC in `worktrees/fuji-408`;
the SIGKILL parent probe ran later the same day. Both were before any source
change. They measure engine interfaces; they do not establish that the wrapper
startup path publishes the result. That path requires a separate post-change
live check.

## Codex

- Installed wrapper dependency: `@openai/codex` 0.156.1. A child of its native
  app-server binary received `initialize`, `initialized`, then
  `account/rateLimits/read` on stdio. No `thread/start`, `thread/resume`, or
  `turn/start` request was sent. The child was closed after the response.
- `initialize` returned a result. The rate-limit read returned a `codex`
  bucket and a legacy `rateLimits` object. Its primary window was
  `usedPercent=19`, `windowDurationMins=10080`, `resetsAt=1790908233`; its
  secondary window was `null`. This proves a current account snapshot is
  readable before a thread or turn on this authenticated host.
- The 12 newest JSONL rollouts under `~/.codex/sessions` were read without
  editing them. Their latest non-null `token_count.rate_limits` had a
  10080-minute primary window and a null secondary window. The three newest
  distinct sessions all reported 19%. Thus a different session's rollout is
  another available snapshot source on this host, but it is an older,
  session-bound observation.
- Neither the app-server response nor those 12 rollout records contained a
  300-minute window. The reader did not drop `five_hour`: the source reported
  no such window in this capture. This is an observation for this account and
  time, not a universal Codex account rule.

The app-server probe used the same initialization parameters and native binary
as `AppServerRpc`, and sent the read method used by `AppServerTransport`. Its
exit code was 0. The rollout probe's exit code was 0. Both probes printed only
the rate-limit fields needed for this question.

## Claude Code

- Installed wrapper dependency: `@anthropic-ai/claude-agent-sdk` 0.3.280.
  `query()` received an async input iterable that did not yield a user message.
  Before consuming the query message stream, the probe called
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` with
  `skipBehaviors: true`, then closed the query.
- The control request resolved in 1415 ms with `rate_limits_available=true`.
  Both `five_hour` and `seven_day` objects were present, each with utilization
  5 percent in this capture. The prompt iterable yielded zero messages. The
  probe process exited 0.
- `WarmQuery` from `startup()` exposes only `query()` and `close()` in the
  installed SDK type declaration. A separate short-lived `Query` is therefore
  the measured interface for a pre-turn `/usage` request while the production
  turn's Query remains deferred for model and effort selection.
- A second SDK probe used a freshly created temporary cwd and the catalog
  probe's minimal Options. It also returned both windows with zero yielded
  input messages and zero files in the temporary cwd; process exit was 0.

The Claude probe did not call the wrapper's production startup path. Its
result establishes that the SDK control request works before the first user
turn on this host; the production-path check remains part of implementation
verification.

## Reproduction commands

Run from the repository worktree root after `pnpm install`. The Codex command
uses the native binary installed by this worktree and prints only the quota
bucket, not account identity. It sends no thread or turn request.

```sh
python3 - <<'PY'
import subprocess,json,selectors,time,os,signal
binary='node_modules/.pnpm/@openai+codex@0.156.1-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex'
p=subprocess.Popen([binary,'--config','approvals_reviewer="user"','--config','approval_policy="never"','--config','analytics.enabled=false','app-server','--listen','stdio://'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
s=selectors.DefaultSelector();s.register(p.stdout,selectors.EVENT_READ)
def request(id,method,params):
 p.stdin.write(json.dumps({'id':id,'method':method,'params':params})+'\n');p.stdin.flush()
 deadline=time.monotonic()+18
 while time.monotonic()<deadline:
  if not s.select(0.5): continue
  line=p.stdout.readline()
  if not line: raise RuntimeError('EOF')
  x=json.loads(line)
  if x.get('id')==id: return x
 raise TimeoutError(method)
try:
 init=request(1,'initialize',{'clientInfo':{'name':'fuji-408-probe','version':'0'},'capabilities':{'experimentalApi':False}})
 print('initialize', 'result' if 'result' in init else init.get('error'))
 p.stdin.write(json.dumps({'method':'initialized','params':None})+'\n');p.stdin.flush()
 rate=request(2,'account/rateLimits/read',{})
 if 'error' in rate: print('read_error',rate['error'])
 else:
  x=rate['result'];print('read_result',json.dumps({'has_rateLimits':bool(x.get('rateLimits')),'bucket_ids':list((x.get('rateLimitsByLimitId') or {}).keys()),'legacy_primary':(x.get('rateLimits') or {}).get('primary'),'legacy_secondary':(x.get('rateLimits') or {}).get('secondary')}))
finally:
 p.stdin.close()
 try:p.wait(timeout=5)
 except subprocess.TimeoutExpired:
  os.kill(p.pid,signal.SIGTERM)
  try:p.wait(timeout=3)
  except subprocess.TimeoutExpired:os.kill(p.pid,signal.SIGKILL);p.wait()
PY
```

The rollout command reads the 12 most recently modified files. Its raw
output contains additional account metadata, so retain only the four fields
relevant to this finding when sharing the result.

```sh
python3 - <<'PY'
import glob,json,os
paths=sorted(glob.glob(os.path.expandvars('$HOME/.codex/sessions/**/*.jsonl'),recursive=True),key=os.path.getmtime,reverse=True)
for path in paths[:12]:
    last=None
    try:
      for line in open(path):
        try: x=json.loads(line)
        except: continue
        p=x.get('payload',{})
        if x.get('type')=='event_msg' and p.get('type')=='token_count' and p.get('rate_limits') is not None:
          last=p['rate_limits']
    except OSError: continue
    print(os.path.basename(path), 'rate_limits=', last)
PY
```

Run the Claude command from `wrapper/claude-code` so its package import
resolves. This command deliberately uses the current working directory;
the implementation plan instead reuses the catalog probe's isolated cwd
and minimal Options.

```sh
node --input-type=module - <<'JS'
import { query } from '@anthropic-ai/claude-agent-sdk';
let yielded=0;
const prompt={async *[Symbol.asyncIterator](){ await new Promise(()=>{}); yielded++; yield {type:'user',message:{role:'user',content:'never'}}; }};
const q=query({prompt,options:{cwd:process.cwd(),permissionMode:'default'}});
const started=Date.now();
let timer;
try {
 const outcome=await Promise.race([
  q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true}).then(v=>({kind:'resolved',rate_limits_available:v.rate_limits_available,five_hour:v.rate_limits?.five_hour ? {utilization:v.rate_limits.five_hour.utilization,resets_at:v.rate_limits.five_hour.resets_at}:null,seven_day:v.rate_limits?.seven_day ? {utilization:v.rate_limits.seven_day.utilization,resets_at:v.rate_limits.seven_day.resets_at}:null}),e=>({kind:'rejected',error:String(e)})),
  new Promise(resolve=>timer=setTimeout(()=>resolve({kind:'timeout'}),15000)),
 ]);
 console.log(JSON.stringify({...outcome,promptYielded:yielded,elapsedMs:Date.now()-started}));
}finally{clearTimeout(timer);q.close();}
JS
```

After `pnpm -C wrapper build`, the existing isolated catalog probe also
returned `ok=true`, five models, source `init`, and elapsed time 1102 ms:

```sh
node wrapper/claude-code/dist/probe.js --timeout-ms 10000 | jq '{ok, model_count:(.models|length), source, reason, elapsed_ms}'
```

The isolated SDK control-request probe was:

```sh
node --input-type=module - <<'JS'
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const cwd=mkdtempSync(join(tmpdir(),'fuji408-isolated-usage-'));
let yielded=0;
const prompt={async *[Symbol.asyncIterator](){await new Promise(()=>{});yielded++;}};
const q=query({prompt,options:{cwd,mcpServers:{},tools:[],allowedTools:[],disallowedTools:[],additionalDirectories:[],agents:{}}});
try{
 const usage=await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true});
 console.log(JSON.stringify({available:usage.rate_limits_available,five_hour:usage.rate_limits?.five_hour!==null,seven_day:usage.rate_limits?.seven_day!==null,yielded,cwd_files:readdirSync(cwd).length}));
}finally{q.close();rmSync(cwd,{recursive:true,force:true});}
JS
```

## SIGKILL parent probe

The condition follows [issue #401](https://github.com/sakuraiyuta/kaoiro/issues/401):
send SIGKILL to a wrapper-like parent while its startup child is alive, then
inspect the captured descendant PIDs. The harness spawned each process and
signalled only the exact PIDs it retained. It read `/proc/<pid>/status` for
exit state and cleaned up only those descendants. The Codex parent sent
`initialize` and held the app-server stdin open; the Claude parent spawned
the built `dist/probe.js` and was killed after its SDK child appeared.

| Child after parent SIGKILL | 100 ms | 800 ms | 2500 ms |
| --- | --- | --- | --- |
| Codex app-server | sleeping | gone | gone |
| Claude catalog probe | sleeping | sleeping | gone |
| Claude SDK child | running | running | gone |

The harness exited 0. On this host, normal stdin EOF and probe completion
cleared the children within 2.5 seconds. The Claude subtree was transiently
orphaned for at least 800 ms. This does not establish cleanup if a child
ignores EOF or SIGTERM; that remains issue #401's separate failure mode.

The exact SIGKILL harness command, run from the worktree root after the build,
was:

```sh
python3 - <<'PY'
import os,signal,subprocess,time,select
root=os.getcwd()
codex=os.path.join(root,'node_modules/.pnpm/@openai+codex@0.156.1-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex')
claude=os.path.join(root,'wrapper/claude-code/dist/probe.js')
def state(pid):
 try:
  s=open(f'/proc/{pid}/status').read().split('State:\t',1)[1].splitlines()[0]
  return s
 except FileNotFoundError:return 'gone'
def children(pid):
 try:return [int(x) for x in open(f'/proc/{pid}/task/{pid}/children').read().split()]
 except FileNotFoundError:return []
def cleanup(pids):
 for pid in pids:
  if state(pid) not in ('gone','Z (zombie)'):
   try:os.kill(pid,signal.SIGTERM)
   except ProcessLookupError:pass
 time.sleep(.25)
 for pid in pids:
  if state(pid) not in ('gone','Z (zombie)'):
   try:os.kill(pid,signal.SIGKILL)
   except ProcessLookupError:pass
for name,code in [
 ('codex',f'''import subprocess,time,sys,json\np=subprocess.Popen([{codex!r},'--config','analytics.enabled=false','app-server','--listen','stdio://'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)\np.stdin.write(json.dumps({{'id':1,'method':'initialize','params':{{'clientInfo':{{'name':'fuji-408-sigkill','version':'0'}},'capabilities':{{'experimentalApi':False}}}}}})+'\\n');p.stdin.flush()\np.stdout.readline()\nprint(p.pid,flush=True)\ntime.sleep(60)'''),
 ('claude',f'''import subprocess,time\np=subprocess.Popen(['node',{claude!r},'--timeout-ms','30000'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)\nprint(p.pid,flush=True)\ntime.sleep(60)''')]:
 wrapper=subprocess.Popen(['python3','-c',code],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
 line=wrapper.stdout.readline().strip();child=int(line)
 descendants=[]
 if name=='claude':
  deadline=time.monotonic()+5
  while time.monotonic()<deadline and not descendants:
   descendants=children(child)
   if not descendants:time.sleep(.02)
  print(name,'before_kill','wrapper',wrapper.pid,'probe',child,'sdk_children',descendants,'probe_state',state(child),flush=True)
 else:print(name,'before_kill','wrapper',wrapper.pid,'appserver',child,'appserver_state',state(child),flush=True)
 os.kill(wrapper.pid,signal.SIGKILL);wrapper.wait()
 for delay in (.1,.8,2.5):
  time.sleep(delay if delay==.1 else delay-(.1 if delay==.8 else .8))
  print(name,'after_ms',round(delay*1000),'child',state(child),'sdk_children',[(pid,state(pid)) for pid in descendants],flush=True)
 cleanup([child,*descendants])
PY
```

The parent PID came from `Popen.pid`. Each child PID was printed by the parent
immediately after its own `Popen`, and the Claude SDK descendant PID came from
that child’s `/proc/<pid>/task/<pid>/children`. No process-name lookup was used
for signalling. The final cleanup loop could signal only the captured child
and descendant PIDs; in this run both were already gone by 2500 ms.

## Post-implementation verification

The measurements below used `pnpm -C wrapper build` from this worktree after
the source changes, on 2026-09-25 17:36–17:39 UTC. Both fresh-idle paths
started with zero turns. The captured first `state_change` had no
`ext.rate_limits`. The real Codex account read produced one follow-up idle
`state_change` with `seven_day.utilization=0.22` and
`resets_at=1790908233`; `CodexHost.statusSnapshot()` held the same value.
The real Claude Code CLI startup path produced one follow-up idle
`state_change` with `five_hour.utilization=0.20` and
`seven_day.utilization=0.06`; its host snapshot matched both windows. No
production Claude Query was opened because no input was sent.

The negative controls used the same startup functions and real hosts. An
isolated `CODEX_HOME` returned zero windows from the built
`readStartupRateLimits()`; passing that measured empty result through
`prepareCodexStartup()` emitted no follow-up and left the field absent. A
Claude CLI startup with its probe boundary returning an unavailable source
likewise emitted no follow-up and left the field absent. The Claude control
uses an injected unavailable probe, so it verifies the wrapper's no-source
branch rather than an unauthenticated SDK account.

The built Claude probe returned `ok=true`, five models, and raw SDK windows
(`five_hour=20`, `seven_day=6`, ISO `resets_at`) with `--usage`. The same
command without `--usage` returned `ok=true`, five models, and no
`rate_limits` key. The first form took 1089 ms and the runner-compatible
default took 1082 ms in this capture. The optional usage timeout test kept
catalog success when the usage promise never settled.

The server's existing `directory_request` test at
`server/test/kaoiro_server_web/channels/wrapper_channel_test.exs:4764`
submitted an idle `state_change` with `ext.rate_limits`, then read it as a
different agent. `mix test` returned exit 0: one test passed, 207 excluded.
The real wrapper runs above captured the same idle envelope path; this server
test covers the `list_agents` projection without adding a turn. The live
wrapper runs used a local link double, not an online server query.

### Reproduction of the startup captures

Build first, then run these commands at the worktree root. They print only
window telemetry. The `turns: 0` field is the harness input count, and
`followup_count` counts host state emissions after the first idle envelope.

```sh
pnpm -C wrapper build
node --input-type=module - <<'JS'
import { CodexHost } from './wrapper/codex/dist/host.js';
import { prepareCodexStartup } from './wrapper/codex/dist/startup.js';
const config={agent_id:'fuji408.codex',persona:{id:'fuji',name:'Fuji',sprite_set:'fuji'},display_name:'Fuji',server_url:'ws://unused'};
const emitted=[];
const host=new CodexHost(config,{onState:e=>emitted.push(e),appendSystemPrompt:'probe'});
await prepareCodexStartup({config,prompt:undefined,resumeSessionId:undefined,host,link:{setSessionId(){},send:e=>emitted.push(e)},sidecar:{bind(){}},printState(){},now:()=>new Date().toISOString()});
const initial=emitted[0];
const deadline=Date.now()+12000;
while(emitted.length===1&&Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
console.log(JSON.stringify({turns:0,initial_rate_limits:initial?.ext?.rate_limits??null,followup_count:emitted.length-1,followup_rate_limits:emitted.at(-1)?.ext?.rate_limits??null,status_rate_limits:host.statusSnapshot().rate_limits??null}));
host.close();
JS
node --input-type=module - <<'JS'
import { AgentHost } from './wrapper/claude-code/dist/host.js';
import { runClaudeCli } from './wrapper/claude-code/dist/cli.js';
const config={agent_id:'fuji408.claude',persona:{id:'fuji',name:'Fuji',sprite_set:'fuji'},display_name:'Fuji',server_url:'ws://unused'};
const emitted=[];let host;
const timer=setTimeout(()=>host?.close(),12000);
try {
 await runClaudeCli({
  parseCliArgs:()=>({configPath:'probe',prompt:undefined,resume:undefined}),loadConfig:()=>config,
  createServerLink:(_url,_id,options)=>{queueMicrotask(()=>options.onPersonaPrompt?.('probe'));return{close(){},currentSessionId:()=>null,send:e=>emitted.push(e)};},
  createHost:(cfg,options)=>(host=new AgentHost(cfg,{...options,onState:e=>{emitted.push(e);if(e.ext?.rate_limits)queueMicrotask(()=>host.close());}})),
 });
 console.log(JSON.stringify({turns:0,initial_rate_limits:emitted[0]?.ext?.rate_limits??null,followup_count:emitted.length-1,followup_rate_limits:emitted.at(-1)?.ext?.rate_limits??null,status_rate_limits:host.statusSnapshot().rate_limits??null}));
} finally {clearTimeout(timer);host?.close();}
JS
```

The source-free controls used the corresponding host start paths. For Codex,
set `process.env.CODEX_HOME` to a fresh `mkdtempSync` directory before calling
the built `readStartupRateLimits()`; it returned `Map(0)`. Pass that result
as `startupRateLimitResolver: async () => source`, call
`prepareCodexStartup()` with the same arguments above, wait 100 ms, and
check `followup_count=0` and absent host `rate_limits`. Restore `CODEX_HOME`
and remove only that captured temporary directory in `finally`. For Claude,
replace the host construction above with a real `AgentHost` given
`probeFn: async () => ({ok:false, reason:'auth_failed', elapsed_ms:0})`;
the probe was requested, but the result has no windows and the emitted
follow-up count was zero. These are the exact source boundaries used in the
two negative-control runs.

```sh
node wrapper/claude-code/dist/probe.js --usage | jq '{ok, source, model_count:(.models|length), rate_limits, elapsed_ms}'
node wrapper/claude-code/dist/probe.js | jq '{ok, source, model_count:(.models|length), has_rate_limits:has("rate_limits"), elapsed_ms}'
cd server
mix deps.get
mix test test/kaoiro_server_web/channels/wrapper_channel_test.exs:4764
```

### Parent SIGKILL after implementation

This reran the issue #401 condition against the built production functions:
`readStartupRateLimits()` for Codex and `runClaudeProbe({includeUsage:true})`
for Claude. Only PIDs captured from the `Popen` wrapper and that wrapper's
own `/proc/.../children` tree were signalled. The Codex child was still
sleeping at 100 ms and gone by 800 ms. The Claude probe child and SDK child
were still sleeping at 800 ms and both gone by 2500 ms. The final cleanup
loop was limited to those captured child PIDs, and neither needed signalling
at 2500 ms.

```sh
python3 - <<'PY'
import subprocess,time,os,signal
root=os.getcwd()
def state(pid):
 try:return open(f'/proc/{pid}/status').read().split('State:\t',1)[1].splitlines()[0]
 except FileNotFoundError:return 'gone'
def children(pid):
 try:return [int(x) for x in open(f'/proc/{pid}/task/{pid}/children').read().split()]
 except FileNotFoundError:return []
def cleanup(pids):
 for sig in (signal.SIGTERM,signal.SIGKILL):
  for pid in pids:
   if state(pid) not in ('gone','Z (zombie)'):
    try:os.kill(pid,sig)
    except ProcessLookupError:pass
  time.sleep(.2)
scripts={
 'codex':"import {readStartupRateLimits} from './wrapper/codex/dist/startup_rate_limits.js'; await readStartupRateLimits();",
 'claude':"import {runClaudeProbe} from './wrapper/claude-code/dist/probe-client.js'; await runClaudeProbe({includeUsage:true});",
}
for name,script in scripts.items():
 wrapper=subprocess.Popen(['node','--input-type=module','-e',script],cwd=root,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 child=None;descendants=[];deadline=time.monotonic()+4
 while time.monotonic()<deadline:
  current=children(wrapper.pid)
  if current:
   child=current[0]
   if name=='codex':break
   descendants=children(child)
   if descendants:break
  time.sleep(.005)
 if child is None or (name=='claude' and not descendants):
  print(name,'capture_failed','wrapper_state',state(wrapper.pid),'child',child,'descendants',descendants,flush=True)
  if state(wrapper.pid)!='gone':os.kill(wrapper.pid,signal.SIGTERM)
  wrapper.wait();cleanup([child,*descendants] if child else descendants);continue
 print(name,'before','wrapper',wrapper.pid,'child',child,'sdk_children',descendants,'states',[state(x) for x in [child,*descendants]],flush=True)
 os.kill(wrapper.pid,signal.SIGKILL);wrapper.wait()
 previous=0
 for ms in (100,800,2500):
  time.sleep((ms-previous)/1000);previous=ms
  print(name,'after_ms',ms,'states',[state(x) for x in [child,*descendants]],flush=True)
 cleanup([child,*descendants])
PY
```

Removing each startup probe call or each native-arrival guard separately
caused its focused test to fail (four red checks). Removing the host-close
abort likewise failed its focused test (fifth red check). Restoring each line made
those tests pass. The usage timeout test also passed. The mutation checks
were performed on the worktree and no mutated line remains in the source.

### Final artifact check

After restoring the mutation checks, changing the tool descriptions, and
adding cancellation of an outstanding Claude startup child on host close,
`pnpm -C wrapper build` exited 0 again. On 2026-09-25 17:43 UTC, the built
Codex host still emitted one zero-turn follow-up with `seven_day=0.23`; the
built Claude CLI host emitted one with `five_hour=0.22` and `seven_day=0.07`.
Both first idle envelopes had no rate limits, both host snapshots matched
their follow-ups, and both injected source-free controls had zero follow-ups
and no host field. The final built Claude probe returned five models and raw
22/7 percent windows with `--usage`; without it, the output had no
`rate_limits` key. Repeating the captured-PID SIGKILL probe after this final
build gave the same exit bounds: Codex child gone by 800 ms; Claude probe and
SDK child gone by 2500 ms.
The final rebuild at 17:47 UTC repeated the zero-turn controls: Codex
`seven_day=0.23`, Claude `five_hour=0.22` and `seven_day=0.07`, with no field
or follow-up for either empty source. The captured-PID SIGKILL check after
this rebuild again saw Codex gone by 800 ms and both Claude children gone by
2500 ms. Host-close cancellation separately has a tested SIGTERM and
SIGKILL escalation when the child stays open.
The final built `runCodexCli` entrypoint was also exercised at 17:48 UTC
with a local link and no prompt, once for `exec` and once for `app-server`.
Each backend sent its first idle state without the field, then exactly one
follow-up containing `seven_day=0.23`; no turn was started. The live link
was a local double, so the server projection result above is the separate
`list_agents` side of this path.

The full Codex CLI check can be repeated from the worktree root after the
build. The injected local link only captures envelopes; `CodexHost` and the
account read use their production defaults.

```sh
node --input-type=module - <<'JS'
import {CodexHost} from './wrapper/codex/dist/host.js';
import {runCodexCli} from './wrapper/codex/dist/cli.js';
for (const backend of ['exec','app-server']) {
 const config={agent_id:'fuji408.codex-cli',persona:{id:'fuji',name:'Fuji',sprite_set:'fuji'},display_name:'Fuji',server_url:'ws://unused',codex_backend:backend};
 const sent=[];let host;const timer=setTimeout(()=>host?.close(),12000);
 try {
  await runCodexCli({
   parseCliArgs:()=>({configPath:'probe',prompt:undefined,resume:undefined}),loadConfig:()=>config,
   createServerLink:(_url,_id,options)=>{queueMicrotask(()=>options.onPersonaPrompt?.('probe'));return{close(){},currentSessionId:()=>null,send:e=>sent.push(e),reportSessionLifecycle(){},setSessionId(){},acknowledgeInterAgentDelivery(){},flushInterAgentRetirements:async()=>{},reportDisconnectIntent:async()=>{}};},
   createHost:(cfg,options)=>(host=new CodexHost(cfg,{...options,onState:e=>{sent.push(e);if(e.ext?.rate_limits)queueMicrotask(()=>host.close());}})),
  });
  console.log(JSON.stringify({backend,turns:0,initial:sent[0]?.ext?.rate_limits??null,followup_count:sent.length-1,followup:sent.at(-1)?.ext?.rate_limits??null,host:host.statusSnapshot().rate_limits??null}));
 } finally {clearTimeout(timer);host?.close();}
}
JS
```

The final build artifacts measured above are bound to these SHA-256 values:

| Artifact | SHA-256 |
| --- | --- |
| `wrapper/codex/dist/host.js` | `d64fe4c0cb454809575df2a5f4bf10f8ceaef739a12620424ab63c166a3801fe` |
| `wrapper/codex/dist/startup.js` | `1eee642c0bcaca7817c16a26e5e3b2eb17539f4c9ae99b6e879523035a438333` |
| `wrapper/codex/dist/startup_rate_limits.js` | `72588e5c3c19cb54ff828c685262092de6481c8ce2a6aeded9545e5d1ddefc60` |
| `wrapper/claude-code/dist/cli.js` | `e3ff2626a20d5b7650dea475199b96b3529e5c73856f24dd1551d5d5320f5833` |
| `wrapper/claude-code/dist/host.js` | `3da82e5e595820a6c33b2212b3a22661217cdb73d9e5b5e984aef6b02596632d` |
| `wrapper/claude-code/dist/probe.js` | `f1638686a4a3e1a10b9d49dfb1527ddf55d23c148d67196b93bcdd8c38fabd45` |
| `wrapper/claude-code/dist/probe-client.js` | `23a60155ca504debef5f12993febca09dcbbc83fc807ba9073d23175e0471c06` |
| `wrapper/agent-common/dist/inter_agent.js` | `fc68e5b3b5045dbe555523362615dc8369be60ba87c2519afb88a84e2ed69395` |

Final package gates on this source: `@kaoiro/agent-common` typecheck 0,
test 0 (371 passed); `@kaoiro/codex` typecheck 0, test 0 (805 passed);
`@kaoiro/claude-code` typecheck 0, test 0 (512 passed). No unhandled test
errors appeared in the three final Vitest logs. The separate server
directory projection test exited 0 (one passed).
