// Throwaway judge for kaoiro issue 1044 (design 6.5).  One tool, four modes:
//   --selftest                                  pin the byte predicate (N7)
//   --mkexpect <outDir> <expect.json>           build the expectation from raw
//   --mutate <name> <in.json> <out.json>        one negative control (N1..N6, N9)
//   <outDir> <expect.json>                      evaluate J0 and J1..J27
// J23 is vacant (withdrawn at design r5).  O1..O6 print without affecting exit.
//
// Order conditions use the position in events.jsonl: it is a single
// append-only log, so its line order is the observed order.
// The payload expectation comes from the push record (the input side); the
// request bodies come from the loopback endpoint (the captured side).  These
// are separate sources, so J2/J11/J16 are not a value compared with itself.
import fs from 'node:fs';

const argv = process.argv.slice(2);
const ALWAYS_TRUE = process.env.JUDGE_MUTATE_BYTES === '1'; // N7
const includesBytes = (text, input) => (ALWAYS_TRUE
  ? true
  : Buffer.from(text, 'utf8').includes(Buffer.from(input, 'utf8')));
const exact = (a, b) => a === b;

const readJsonl = (p) => (fs.existsSync(p)
  ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  : []);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function collect(messages, pick) {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const taken = pick(node);
    if (taken !== undefined) { out.push(...taken); return; }
    if (Array.isArray(node.content)) walk(node.content);
  };
  walk(messages);
  return out;
}
const toolResultTexts = (m) => collect(m, (n) => {
  if (n.type !== 'tool_result') return undefined;
  if (typeof n.content === 'string') return [n.content];
  if (Array.isArray(n.content)) return n.content.filter((b) => typeof b?.text === 'string').map((b) => b.text);
  return [];
});
const anyText = (m) => collect(m, (n) => {
  const got = [];
  if (typeof n.text === 'string') got.push(n.text);
  if (typeof n.content === 'string') got.push(n.content);
  return got.length && !Array.isArray(n.content) ? got : undefined;
}).concat(toolResultTexts(m));

// ---- mode: --selftest ----
if (argv[0] === '--selftest') {
  const ok = includesBytes('<x>\nE_BODY ticket\n</x>', 'E_BODY ticket');
  const bad = includesBytes('<x>\nE_BODY ticket\n</x>', 'X_BODY ticket');
  if (ok !== true || bad !== false) { console.log('judge selftest FAILED (byte predicate)'); process.exit(1); }
  console.log('judge selftest passed');
  process.exit(0);
}

const TABLE = {
  B0: { kind: 'B', requests: 2, results: 1 },
  F1: { kind: 'F', requests: 2, results: 1, sameAsInitial: true, foldBeforeTerminal: true, order: ['fold', 'request2', 'terminal'] },
  T1: { kind: 'T', requests: 2, results: 2, sameAsInitial: false, terminalIndices: [0, 1], firstTerminalCount: 1, terminalBeforeNewHook: true, order: ['terminal1', 'newhook', 'request2', 'terminal2'] },
  P1: { kind: 'P', requests: 2, results: 2, sameAsInitial: false, terminalIndices: [0, 1], firstTerminalCount: 1, toolEndBeforeTerminal: true, order: ['toolend', 'terminal1', 'newhook', 'request2', 'terminal2'] },
  F2: { kind: 'F', requests: 2, results: 1, sameAsInitial: true, foldBeforeTerminal: true, order: ['fold', 'request2', 'terminal'] },
};

// ---- mode: --mkexpect ----
if (argv[0] === '--mkexpect') {
  const [, outDir, dest] = argv;
  const runs = {};
  for (const [run, want] of Object.entries(TABLE)) {
    const events = readJsonl(`${outDir}/${run}.events.jsonl`);
    const push = events.find((e) => e.type === 'seam_push');
    const setup = events.find((e) => e.type === 'setup');
    runs[run] = { ...want, payload: (want.kind === 'B' ? setup?.payload : push?.payload) ?? null };
  }
  fs.writeFileSync(dest, `${JSON.stringify({ isError: false, runs }, null, 2)}\n`);
  console.log(`wrote ${dest}`);
  process.exit(0);
}

// ---- mode: --mutate ----
if (argv[0] === '--mutate') {
  const [, name, src, dest] = argv;
  const e = readJson(src);
  const swap = (run, order) => { e.runs[run].order = order; };
  const withPayload = Object.keys(e.runs).filter((r) => e.runs[r].payload != null);
  const muts = {
    N1: () => { for (const r of withPayload) e.runs[r].payload = e.runs[r].payload.replace('E_INPUT_', 'X_INPUT_'); },
    N2: () => {
      for (const r of withPayload) {
        e.runs[r].payload = e.runs[r].payload.replace(/("reply_ticket":")(.)/, (_, a, b) => a + (b === 'A' ? 'B' : 'A'));
      }
    },
    N3: () => { for (const r of ['F1', 'F2']) e.runs[r].sameAsInitial = false; },
    N4: () => { for (const r of ['T1', 'P1']) e.runs[r].sameAsInitial = true; },
    N5a: () => { swap('F1', ['request2', 'fold', 'terminal']); e.runs.F1.foldBeforeTerminal = false; },
    N5b: () => { swap('T1', ['newhook', 'terminal1', 'request2', 'terminal2']); e.runs.T1.terminalBeforeNewHook = false; },
    N5c: () => { swap('P1', ['terminal1', 'toolend', 'newhook', 'request2', 'terminal2']); e.runs.P1.toolEndBeforeTerminal = false; },
    N6: () => {
      e.runs.P1.terminalIndices = [0, 2];
      e.runs.P1.firstTerminalCount = 2;
      e.runs.T1.terminalIndices = [0, 2];
    },
    N9: () => { e.isError = true; },
  };
  if (!muts[name]) { console.log(`unknown mutation ${name}`); process.exit(2); }
  muts[name]();
  const before = JSON.stringify(readJson(src));
  if (JSON.stringify(e) === before) { console.log(`mutation ${name} changed nothing`); process.exit(2); }
  fs.writeFileSync(dest, `${JSON.stringify(e, null, 2)}\n`);
  console.log(`wrote ${dest} (${name})`);
  process.exit(0);
}

// ---- mode: judge ----
const [outDir, expectPath] = argv;
const expect = readJson(expectPath);
let failures = 0;
const lines = [];
const judge = (run, id, cond, note) => {
  const pass = cond === true;
  if (!pass) failures += 1;
  lines.push(`${pass ? 'PASS' : 'FAIL'} ${run} ${id}  ${note}`);
};
const observe = (run, id, note) => lines.push(`OBS  ${run} ${id}  ${note}`);

for (const [run, want] of Object.entries(expect.runs)) {
  const events = readJsonl(`${outDir}/${run}.events.jsonl`);
  const requests = readJsonl(`${outDir}/${run}.requests.jsonl`);
  const checkPath = `${outDir}/${run}.check.json`;
  const check = fs.existsSync(checkPath) ? readJson(checkPath) : null;
  const at = (pred) => events.findIndex(pred);
  const all = (pred) => events.filter(pred);
  const results = all((e) => e.type === 'sdk_frame' && e.frame.type === 'result');
  const hooks = all((e) => e.type === 'hook' && e.input.hook_event_name === 'UserPromptSubmit');
  const { payload } = want;
  const finished = events.find((e) => e.type === 'finished');

  const j0 = at((e) => e.type === 'sdk_start') >= 0 && at((e) => e.type === 'run_error') < 0
    && requests.length === want.requests && results.length === want.results && finished !== undefined;
  judge(run, 'J0', j0, `sdk_start=${at((e) => e.type === 'sdk_start') >= 0} run_error=${at((e) => e.type === 'run_error') >= 0}`
    + ` requests=${requests.length}/${want.requests} results=${results.length}/${want.results} finished=${finished !== undefined}`);
  if (!j0) { lines.push(`SKIP ${run}  measurement not established; this run yields no premise verdict`); continue; }

  const req = (n) => requests.find((r) => r.request === n);
  const containsIn = (n, extract) => {
    const r = req(n);
    return r && payload != null ? extract(r.body.messages).some((t) => includesBytes(t, payload)) : false;
  };

  judge(run, 'J19', requests.length === want.requests && results.length === want.results,
    `raw requests=${requests.length} results=${results.length}`);
  judge(run, 'J20', at((e) => e.type === 'run_error') < 0, 'no run_error event');
  judge(run, 'J21', finished.owned_children === 0, `owned_children=${finished.owned_children}`);
  judge(run, 'J27', results.every((e) => e.frame.is_error === expect.isError),
    `is_error=[${results.map((e) => e.frame.is_error).join(',')}] expected=${expect.isError}`);

  if (want.kind === 'B') {
    judge(run, 'J22', !containsIn(1, anyText) && !containsIn(2, anyText),
      'the un-pushed payload is absent from requests 1 and 2');
  }

  if (want.kind === 'F') {
    const folds = hooks.filter((e) => exact(e.input.prompt, payload));
    const foldIdx = events.indexOf(folds[0]);
    const req2Idx = at((e) => e.type === 'model_request' && e.request === 2);
    const termIdx = at((e) => e.type === 'sdk_frame' && e.frame.type === 'result');
    judge(run, 'J1', !containsIn(1, anyText), 'payload absent from request 1');
    judge(run, 'J2', containsIn(2, toolResultTexts), 'payload present in request 2 tool_result content');
    judge(run, 'J3', check?.request_reference?.length === requests.length
      && check.request_reference.every((r) => r.contains_exact === (r.request === 2)),
      `extractor reference=${JSON.stringify(check?.request_reference)}`);
    judge(run, 'J4', folds.length === 1, `UserPromptSubmit hooks whose text equals the payload=${folds.length}`);
    judge(run, 'J5', folds.length === 1
      && (folds[0].input.prompt_id === hooks[0].input.prompt_id) === want.sameAsInitial,
      `fold prompt_id=${folds[0]?.input.prompt_id} initial=${hooks[0]?.input.prompt_id} expected same=${want.sameAsInitial}`);
    judge(run, 'J6', folds.length === 1
      && (folds[0].ms < results[0].ms) === want.foldBeforeTerminal,
      `fold ms=${folds[0]?.ms} terminal ms=${results[0]?.ms} expected fold first=${want.foldBeforeTerminal}`);
    const hp = check?.hook_predictions ?? [];
    judge(run, 'J7', hp.length === 1 && hp[0].exact_text === true && hp[0].same_as_initial === want.sameAsInitial,
      `extractor hook_predictions=${JSON.stringify(hp)}`);
    const seq = want.order.map((k) => ({ fold: foldIdx, request2: req2Idx, terminal: termIdx })[k]);
    judge(run, 'J24', seq.every((v, i) => v >= 0 && (i === 0 || seq[i - 1] < v)),
      `order ${want.order.join(' -> ')} log positions=[${seq.join(',')}]`);
    const content = toolResultTexts(req(2).body.messages).find((t) => includesBytes(t, payload));
    observe(run, 'O1', `tool_result length=${content?.length} payload length=${payload.length}`);
    observe(run, 'O4', `whole-block equality=${exact(content, payload)}`);
    observe(run, 'O5', `tool_end_marker position=${at((e) => e.type === 'tool_end_marker')} fold hook position=${foldIdx}`);
  }

  if (want.kind === 'T' || want.kind === 'P') {
    const firstTerm = results.find((e) => e.frame.result_index === 0);
    const secondTerm = results.find((e) => e.frame.result_index === 1);
    const newHook = hooks.find((e) => exact(e.input.prompt, payload));
    const pos = {
      toolend: at((e) => e.type === 'tool_end_marker'),
      terminal1: events.indexOf(firstTerm),
      newhook: events.indexOf(newHook),
      request2: at((e) => e.type === 'model_request' && e.request === 2),
      terminal2: events.indexOf(secondTerm),
    };
    const idxs = results.map((e) => e.frame.result_index).slice().sort();
    const sameId = newHook !== undefined && newHook.input.prompt_id === hooks[0].input.prompt_id;
    const relId = want.kind === 'T' ? 'J10' : 'J15';
    judge(run, relId, newHook !== undefined && sameId === want.sameAsInitial,
      `new prompt_id=${newHook?.input.prompt_id} initial=${hooks[0]?.input.prompt_id} expected same=${want.sameAsInitial}`);
    judge(run, want.kind === 'T' ? 'J11' : 'J16', containsIn(2, anyText), 'payload present in request 2');

    if (want.kind === 'T') {
      const toolUses = all((e) => e.type === 'sdk_frame' && Array.isArray(e.frame.message?.content)
        && e.frame.message.content.some((b) => b?.type === 'tool_use'));
      judge(run, 'J8', toolUses.length === 0, `sdk frames carrying a tool_use block=${toolUses.length}`);
      judge(run, 'J9', firstTerm !== undefined && newHook !== undefined
        && (firstTerm.ms < newHook.ms) === want.terminalBeforeNewHook,
        `original terminal ms=${firstTerm?.ms} new hook ms=${newHook?.ms} expected terminal first=${want.terminalBeforeNewHook}`);
      judge(run, 'J12', secondTerm !== undefined && results.length === want.terminalIndices.length
        && JSON.stringify(idxs) === JSON.stringify(want.terminalIndices),
        `terminals=${results.length} indices=[${idxs.join(',')}] expected=[${want.terminalIndices.join(',')}]`);
      judge(run, 'J25', want.order.map((k) => pos[k]).every((v, i, a) => v >= 0 && (i === 0 || a[i - 1] < v)),
        `order ${want.order.join(' -> ')} log positions=[${want.order.map((k) => pos[k]).join(',')}]`);
    } else {
      judge(run, 'J13', pos.toolend >= 0 && firstTerm !== undefined
        && (events[pos.toolend].ms < firstTerm.ms) === want.toolEndBeforeTerminal,
        `tool_end_marker ms=${events[pos.toolend]?.ms} original terminal ms=${firstTerm?.ms} expected tool end first=${want.toolEndBeforeTerminal}`);
      judge(run, 'J14', results.filter((e) => e.frame.result_index === 0).length === want.firstTerminalCount,
        `result_index 0 count=${results.filter((e) => e.frame.result_index === 0).length} expected=${want.firstTerminalCount}`);
      judge(run, 'J17', secondTerm !== undefined, `second terminal result_index=${secondTerm?.frame.result_index}`);
      judge(run, 'J18', results.length === want.terminalIndices.length
        && JSON.stringify(idxs) === JSON.stringify(want.terminalIndices),
        `terminals=${results.length} indices=[${idxs.join(',')}] expected=[${want.terminalIndices.join(',')}]`);
      judge(run, 'J26', want.order.map((k) => pos[k]).every((v, i, a) => v >= 0 && (i === 0 || a[i - 1] < v)),
        `order ${want.order.join(' -> ')} log positions=[${want.order.map((k) => pos[k]).join(',')}]`);
    }
  }

  observe(run, 'O2', `result strings=${JSON.stringify(results.map((e) => e.frame.result ?? null))}`);
  observe(run, 'O3', `first event at=${events[0]?.at} finished at=${finished.at} duration_ms=${finished.duration_ms}`);
  observe(run, 'O6', `child_exit=${JSON.stringify(all((e) => e.type === 'child_exit').map((e) => ({ code: e.code, signal: e.signal })))}`);
}

console.log(lines.join('\n'));
console.log(`\nJUDGE failures=${failures}`);
process.exit(failures ? 1 : 0);
