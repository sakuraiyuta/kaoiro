import "../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scan, shellLines, type Scan } from "./codexStateRecoveryScan.js";
import { EXCLUDED, PRECONDITIONS, PROTECTED, RECIPES, ids } from "./codexStateRecoveryRecipes.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const deploy = join(repo, "runner/deploy");
const recovery: any = await import(pathToFileURL(join(deploy, "codex-state-recovery.mjs")).href);
const SHELL = ["kaoiro-runner-update.sh", "kaoiro-runner-switch.sh", "kaoiro-runner-install.sh", "kaoiro-runner-common.sh"];
const { ANCHORS, CAUSAL, CLASSES, COMMANDS, GUARDS, LABELS, OUTCOMES, PHASES, REFUSALS, RETHROWS, SERVICE_OPS, SHARED_MESSAGES, SHELL_REFUSALS, TABLE } = recovery;
const FIELDS = {
  branch: ["id", "cmds", "outcome", "pre", "message", "class", "site", "pin", "final", "service"],
  via: ["id", "cmds", "guard"],
  guard: ["id", "messages", "class", "pin", "service"],
  service: ["before", "op", "pre"],
  refusal: ["files"],
  shared: ["class", "reason"],
};
const unknown = (value: object, allowed: string[]) => Object.keys(value).filter(key => !allowed.includes(key));
const sample = (key: string) => key.replaceAll("${}", "x");

// The structural checks over the exported declarations; each returns the
// list of violations so that a negative control fails on an assertion.
export function schemaProblems(m: any) {
  const problems: string[] = [];
  if (Object.keys(m.TABLE).join() !== m.PHASES.join()) problems.push("TABLE rows differ from PHASES");
  for (const [phase, row] of Object.entries(m.TABLE) as [string, any][]) {
    problems.push(...unknown(row, ["next", "branches"]).map(f => `${phase}: unknown field ${f}`));
    for (const key of row.next) if (!["RES", "REC", "RST", "PRN", "RBK"].includes(key)) problems.push(`${phase}: next ${key}`);
    for (const cmd of m.COMMANDS) if (!row.branches.some((x: any) => x.cmds.includes(cmd))) problems.push(`${phase}/${cmd}: no branch`);
    for (const x of row.branches as any[]) {
      problems.push(...unknown(x, x.guard ? FIELDS.via : FIELDS.branch).map(f => `${x.id}: unknown field ${f}`));
      if (x.guard && !m.GUARDS.some((g: any) => g.id === x.guard)) problems.push(`${x.id}: unknown guard ${x.guard}`);
      if (!x.guard && !m.OUTCOMES.includes(x.outcome)) problems.push(`${x.id}: outcome ${x.outcome}`);
      if (x.message !== undefined && !m.CAUSAL.includes(x.class)) problems.push(`${x.id}: class ${x.class}`);
      if ((x.message === undefined) !== (x.class === undefined)) problems.push(`${x.id}: message and class come together`);
    }
  }
  for (const g of m.GUARDS as any[]) {
    problems.push(...unknown(g, FIELDS.guard).map(f => `${g.id}: unknown field ${f}`));
    if (!m.CAUSAL.includes(g.class)) problems.push(`${g.id}: class ${g.class}`);
  }
  for (const [key, entry] of Object.entries(m.REFUSALS)) problems.push(...unknown(entry as object, FIELDS.refusal).map(f => `${key}: unknown field ${f}`));
  for (const [key, entry] of Object.entries(m.SHARED_MESSAGES)) problems.push(...unknown(entry as object, FIELDS.shared).map(f => `${key}: unknown field ${f}`));
  const ids = [...m.branches().map((x: any) => x.id), ...m.GUARDS.map((g: any) => g.id)];
  for (const id of new Set(ids)) if (ids.filter(x => x === id).length > 1) problems.push(`duplicate id ${id}`);
  return problems;
}

// The service cells, read from the exported declarations themselves (not from
// m.branches()) so that a modified copy of TABLE and GUARDS can be checked.
export function serviceSchemaProblems(m: any) {
  const problems: string[] = [];
  const check = (id: string, service: any) => {
    if (service === undefined) return problems.push(`${id}: no service declaration`);
    if (!Object.hasOwn(service, "default")) problems.push(`${id}: no default service variant`);
    for (const [name, cell] of Object.entries(service) as [string, any][]) {
      problems.push(...unknown(cell, FIELDS.service).map(f => `${id}/${name}: unknown field ${f}`));
      if (!Object.hasOwn(m.SERVICE_OPS, cell.op)) problems.push(`${id}/${name}: unknown operation ${cell.op}`);
      if (!m.SERVICE_STATES.includes(cell.before)) problems.push(`${id}/${name}: unknown initial activity ${cell.before}`);
    }
  };
  for (const row of Object.values(m.TABLE) as any[]) for (const x of row.branches as any[]) {
    if (x.guard) { const guard = m.GUARDS.find((g: any) => g.id === x.guard); if (guard && guard.service === undefined) problems.push(`${x.id}: referenced guard ${x.guard} has no service declaration`); }
    else check(x.id, x.service);
  }
  for (const g of m.GUARDS as any[]) check(g.id, g.service);
  return problems;
}

export function correspondence(m: any, recipes: Record<string, any>, preconditions: Record<string, unknown>) {
  const problems: string[] = [];
  const ids = [...m.branches().filter((x: any) => !x.guard).map((x: any) => x.id), ...m.GUARDS.map((g: any) => g.id)];
  for (const id of ids) if (!Object.hasOwn(recipes, id)) problems.push(`no recipe for ${id}`);
  for (const id of Object.keys(recipes)) if (!ids.includes(id)) problems.push(`recipe for undeclared ${id}`);
  const cells = [...m.branches().filter((x: any) => !x.guard), ...m.GUARDS] as any[];
  // A declared variant has a recipe variant and the other way round.
  for (const x of cells) {
    const declared = Object.keys(x.service ?? {}).filter(name => name !== "default").sort(), provided = Object.keys(recipes[x.id]?.variants ?? {}).sort();
    for (const name of declared) if (!provided.includes(name)) problems.push(`${x.id}: declared variant ${name} has no recipe`);
    for (const name of provided) if (!declared.includes(name)) problems.push(`${x.id}: recipe variant ${name} is undeclared`);
  }
  const names = new Set([...m.branches().map((x: any) => x.pre), ...cells.flatMap(x => Object.values(x.service ?? {}).map((cell: any) => cell.pre))].filter(Boolean));
  for (const name of names as Set<string>) if (!Object.hasOwn(preconditions, name)) problems.push(`no precondition ${name}`);
  for (const name of Object.keys(preconditions)) if (!names.has(name)) problems.push(`precondition ${name} is not used`);
  return problems;
}

// Every message the closure throws gets one rendered class: from the
// branches and guards that raise it, else `unclassified`.
export function classProblems(m: any) {
  const problems: string[] = [];
  const derived = m.classes();
  for (const key of derived.keys()) {
    const shell = SHELL.some(f => Object.keys(m.SHELL_REFUSALS[f] ?? {}).some(line => line.includes(key)));
    if (!Object.hasOwn(m.REFUSALS, key) && !shell) problems.push(`raised message is not cataloged: ${key}`);
  }
  for (const key of Object.keys(m.REFUSALS)) {
    const expected = derived.get(key) ?? "unclassified";
    if (m.classify(sample(key)) !== expected) problems.push(`${key}: renders ${m.classify(sample(key))}, derived ${expected}`);
  }
  for (const [file, lines] of Object.entries(m.SHELL_REFUSALS)) for (const [line, cls] of Object.entries(lines as Record<string, string>)) {
    const raised = m.GUARDS.find((g: any) => g.messages.some((message: string) => line.includes(message)));
    if (m.CAUSAL.includes(cls) && !raised) problems.push(`${file}: ${line}: causal class without a guard`);
    if (raised && cls !== raised.class) problems.push(`${file}: ${line}: ${cls}, guard says ${raised.class}`);
  }
  return problems;
}

export function scanProblems(result: Scan, catalog: Record<string, { files: string[] }>, rethrows: Record<string, string>) {
  const problems = [...result.problems];
  for (const [key, files] of result.keys) {
    if (!Object.hasOwn(catalog, key)) problems.push(`uncataloged message: ${key}`);
    else if ([...files].sort().join() !== [...catalog[key]!.files].sort().join()) problems.push(`${key}: thrown in ${[...files].sort()}, cataloged ${catalog[key]!.files}`);
  }
  for (const key of Object.keys(catalog)) if (!result.keys.has(key)) problems.push(`cataloged message is not thrown: ${key}`);
  for (const id of result.rethrows.keys()) if (!Object.hasOwn(rethrows, id)) problems.push(`undeclared rethrow ${id}`);
  for (const id of Object.keys(rethrows)) if (!result.rethrows.has(id)) problems.push(`rethrow ${id} has no marker`);
  return problems;
}

const slug = (heading: string) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-");

describe("Codex recovery table: structure", () => {
  it("has a known schema, a branch in every cell and unique ids", () => {
    expect(schemaProblems(recovery)).toEqual([]);
  });
  it("declares the service calls of every branch and guard site", () => {
    expect(serviceSchemaProblems(recovery)).toEqual([]);
    expect(Object.keys(SERVICE_OPS)).toEqual(["untouched", "stop", "start", "stop-start"]);
  });
  it("matches the layer-2 recipes and preconditions both ways", () => {
    expect(correspondence(recovery, RECIPES, PRECONDITIONS)).toEqual([]);
  });
  it("lists every declared site and service variant exactly once across the three property files", () => {
    const expected = [...recovery.branches().filter((x: any) => !x.guard), ...GUARDS].flatMap((x: any) => [x.id, ...Object.keys(x.service).filter(name => name !== "default").map(name => `${x.id}:${name}`)]);
    expect([...ids(1), ...ids(2), ...ids(3)].sort()).toEqual(expected.sort());
  });
  it("derives one class for every cataloged message and shell line", () => {
    expect(classProblems(recovery)).toEqual([]);
    expect(CLASSES).toEqual(expect.arrayContaining([...CAUSAL, "usage", "none", "unclassified"]));
  });
  it("gives a causal class only to messages that a branch or guard raises", () => {
    const derived = recovery.classes();
    for (const key of Object.keys(REFUSALS)) if (!derived.has(key)) expect(recovery.classify(sample(key)), key).toBe("unclassified");
  });
  it("renders a fixed advice for every class", () => {
    for (const cls of CLASSES) expect(recovery.render(cls).length >= 0, cls).toBe(true);
    expect(recovery.render("config")).toEqual([`see: ${ANCHORS.config}`]);
    expect(recovery.render("lock", { report: ["lock present: /x"] })).toEqual([`see: ${ANCHORS.lock}`, "lock present: /x"]);
    expect(recovery.render("unclassified")).toEqual([`see: ${ANCHORS.table}`]);
    expect(recovery.render("transient")).toHaveLength(1);
    for (const phase of ["completed", "failed", "restored"]) expect(recovery.render("transient", { tx: { phase, uuid: "u", tool: "t", service: "s.service", home: "/h", snapshot: { path: "/b", status: "retired" } }, root: "/r", deploy: "/d" }).filter((l: string) => !l.startsWith("next ")), phase).toEqual([]);
  });
});

describe("Codex recovery table: rendering", () => {
  const options: Record<string, string> = { RES: "--resume-codex-transaction", REC: "--recover-codex-transaction", RST: "--restore-codex-backup", PRN: "prune", RBK: "--rollback" };
  const root = "/srv/it's a root", self = join(root, "releases/b".repeat(1), "deploy");
  const record = (phase: string) => ({ uuid: "0f8b2a4c-1d2e-4f3a-8b9c-0123456789ab", phase, tool: "t".repeat(40), service: "kaoiro-runner.service", home: "/h/o'me", snapshot: { path: "/b/snap", status: "retained" }, cleanup: { pending: true } });
  it.each(PHASES as string[])("renders each %s entry with its own option, tool and record", (phase: string) => {
    const tx = record(phase), context = { root, deploy: self, interpreter: "/usr/bin/node" };
    const keys = recovery.entries(tx);
    expect(keys).toEqual(TABLE[phase].next);
    for (const key of keys) {
      const argv = recovery.argv(key, tx, context), line = recovery.rowLines(tx, context, [key])[0]!;
      expect(line.startsWith(`next (${LABELS[key]}): `)).toBe(true);
      expect(argv).toContain(options[key]);
      if (["RES", "REC"].includes(key)) expect(argv[0]).toBe(join(root, "releases", tx.tool, "deploy/kaoiro-runner-update.sh"));
      else if (key === "PRN") expect(argv.slice(0, 2)).toEqual(["/usr/bin/node", join(self, "kaoiro-runner-codex-state.mjs")]);
      else expect(argv[0]!.startsWith(self + "/")).toBe(true);
      if (["RES", "REC", "PRN"].includes(key)) expect(argv.at(-1)).toBe(tx.uuid);
      const shell = spawnSync("/bin/sh", ["-c", 'eval "set -- $1"; printf "%s\\n" "$@"', "parse", line.slice(line.indexOf(": ") + 2)], { encoding: "utf8" });
      expect(shell.stdout).toBe(argv.map((a: string) => a + "\n").join(""));
    }
  });
  it("offers restore and prune only for a retained snapshot or pending cleanup", () => {
    const tx = { ...record("completed"), snapshot: { path: "/b/snap", status: "retired" }, cleanup: undefined };
    expect(recovery.entries(tx)).toEqual(["RBK"]);
    expect(recovery.entries({ ...tx, cleanup: { pending: true } })).toEqual(["PRN", "RBK"]);
  });
});

describe("Codex recovery table: fail-closed scan", () => {
  const helper = join(deploy, "kaoiro-runner-codex-state.mjs");
  it("finds exactly the cataloged messages, files and rethrows in the static closure", () => {
    const result = scan(helper);
    expect(result.files.map(f => f.slice(deploy.length + 1)).sort()).toEqual(["child-process-environment.mjs", "codex-native.mjs", "codex-service.mjs", "codex-snapshot.mjs", "codex-state-recovery.mjs", "kaoiro-runner-codex-state.mjs", "verify-release.mjs"]);
    expect(scanProblems(result, REFUSALS, RETHROWS)).toEqual([]);
  });
  // Fixtures for the scanner's own fail-closed rules.
  const fixture = (files: Record<string, string>) => scan("/f/entry.mjs", path => files[path] ?? (() => { throw new Error(`fixture has no ${path}`); })());
  const clean = { "/f/entry.mjs": 'import { must } from "./lib.mjs";\n// a comment that says throw value\nmust(true, "Known message");\n', "/f/lib.mjs": "export function must(c, m) { if (!c) throw new Error(m); }\n" };
  const catalog = { "Known message": { files: ["entry.mjs"] } };
  it("passes a clean fixture", () => {
    expect(scanProblems(fixture(clean), catalog, {})).toEqual([]);
  });
  it("fails an unknown throw form", () => {
    const problems = scanProblems(fixture({ ...clean, "/f/entry.mjs": clean["/f/entry.mjs"] + "const e = 1;\nthrow e;\n" }), catalog, {});
    expect(problems).toEqual(["entry.mjs:5: unmarked throw"]);
  });
  it("fails an uncataloged message in an existing file and in a newly imported one", () => {
    expect(scanProblems(fixture({ ...clean, "/f/entry.mjs": clean["/f/entry.mjs"] + 'must(true, "New message");\n' }), catalog, {})).toEqual(["uncataloged message: New message"]);
    const imported = { ...clean, "/f/entry.mjs": 'import "./more.mjs";\n' + clean["/f/entry.mjs"], "/f/more.mjs": 'throw new Error(`More ${1}`);\n' };
    expect(scanProblems(fixture(imported), catalog, {})).toEqual(["uncataloged message: More ${}"]);
  });
  it("fails a message that is neither a literal nor a template", () => {
    expect(scanProblems(fixture({ ...clean, "/f/entry.mjs": clean["/f/entry.mjs"] + "const m = 'x';\nmust(false, m);\n" }), catalog, {})).toEqual(["entry.mjs:5: message is not a literal or template"]);
  });
});

describe("Codex recovery table: shell, anchors, citations, markers and runbook", () => {
  it.each(SHELL)("catalogs every refusal line of %s with its derived class", file => {
    const lines = shellLines(readFileSync(join(deploy, file), "utf8"));
    expect(Object.keys(SHELL_REFUSALS[file]).sort()).toEqual([...new Set(lines.map(l => l.key))].sort());
    for (const line of lines) {
      const guard = GUARDS.find((g: any) => g.messages.some((m: string) => line.key.includes(m)));
      expect(SHELL_REFUSALS[file][line.key], line.key).toBe(guard ? guard.class : line.exit === 64 ? "usage" : "none");
    }
  });
  it("names only anchors that exist", () => {
    for (const anchor of Object.values(ANCHORS) as string[]) {
      const [file, id] = anchor.split("#") as [string, string];
      const headings = readFileSync(join(repo, file), "utf8").split("\n").filter(l => /^#+ /.test(l)).map(l => slug(l.replace(/^#+ /, "")));
      expect(headings, anchor).toContain(id);
    }
  });
  it("cites only existing N2 test titles", () => {
    const tests = readdirSync(join(repo, "runner/test")).filter(f => /^codexState\w*\.test\.ts$/.test(f) && !/^codexStateRecovery(Table|Forward|Restore|Refusals)\./.test(f)).map(f => readFileSync(join(repo, "runner/test", f), "utf8")).join("\n");
    for (const entry of [...recovery.branches(), ...GUARDS] as any[]) if (entry.pin) expect(tests.includes(`"${entry.pin}"`), `${entry.id}: ${entry.pin}`).toBe(true);
  });
  it("marks every declared site, and declares every marked one", () => {
    const sources = [...scan(join(deploy, "kaoiro-runner-codex-state.mjs")).files, ...SHELL.map(f => join(deploy, f))].map(f => readFileSync(f, "utf8")).join("\n");
    const marked = [...sources.matchAll(/codex-recovery-site: ([A-Za-z0-9 .-]+)/g)].flatMap(m => m[1]!.trim().split(/\s+/));
    const declared = [...GUARDS.map((g: any) => g.id), ...recovery.branches().filter((x: any) => x.site).map((x: any) => x.id)];
    expect([...new Set(marked)].sort()).toEqual([...declared].sort());
  });
  it("renders the service cell of every branch, guard and via row", () => {
    const rows = recovery.runbook().split("\n");
    for (const x of recovery.branches() as any[]) {
      const cell = recovery.serviceCell(x.guard ? GUARDS.find((g: any) => g.id === x.guard).service : x.service);
      expect(rows.find((row: string) => row.includes(`| ${x.id} |`))!, x.id).toContain(`| ${cell} |`);
    }
    for (const g of GUARDS) expect(rows.find((row: string) => row.startsWith(`| ${g.id} |`))!, g.id).toContain(`| ${recovery.serviceCell(g.service)} |`);
    expect(recovery.serviceCell(undefined)).toBe("?");
  });
  it("keeps the generated runbook table", () => {
    const text = readFileSync(join(repo, "docs/operations/runner-update-and-rollback.md"), "utf8");
    const generated = text.split("<!-- recovery-table:begin -->")[1]?.split("<!-- recovery-table:end -->")[0]?.trim();
    expect(generated).toBe(recovery.runbook());
  });
  it("never excludes protected state from the zero-mutation digest", () => {
    for (const path of EXCLUDED) for (const root of PROTECTED) expect(path === root || path.startsWith(root.endsWith("-") ? root : root + "/"), `${path} under ${root}`).toBe(false);
  });
});

describe("Codex recovery table: service declaration rejection cases", () => {
  // A copy of the declarations whose branches() follows the copy.
  const copy = (change: (m: { TABLE: any; GUARDS: any[] }) => void) => {
    const m = structuredClone({ TABLE: recovery.TABLE, GUARDS: recovery.GUARDS });
    change(m);
    const branches = () => { const done = new Set<any>(); return (recovery.PHASES as string[]).flatMap(phase => m.TABLE[phase].branches.filter((x: any) => !done.has(x.id) && done.add(x.id)).map((x: any) => ({ ...x, phase }))); };
    return { ...recovery, TABLE: m.TABLE, GUARDS: m.GUARDS, branches };
  };
  // Declarations share cell objects between branches; a change must reach one branch only.
  const branch = (m: any, id: string) => {
    const x = (Object.values(m.TABLE) as any[]).flatMap(row => row.branches).find((y: any) => y.id === id);
    if (x.service) x.service = structuredClone(x.service);
    return x;
  };
  it("accepts the real declarations and an unchanged copy", () => {
    expect(serviceSchemaProblems(recovery)).toEqual([]);
    expect(serviceSchemaProblems(copy(() => {}))).toEqual([]);
    expect(correspondence(copy(() => {}), RECIPES, PRECONDITIONS)).toEqual([]);
  });
  it("rejects an absent service declaration on a branch and on a guard", () => {
    expect(serviceSchemaProblems(copy(m => { delete branch(m, "P-RES-ok").service; }))).toEqual(["P-RES-ok: no service declaration"]);
    expect(serviceSchemaProblems(copy(m => { delete m.GUARDS.find(g => g.id === "G1.run").service; }))).toEqual(["G1.run: no service declaration"]);
  });
  it("rejects an unknown operation and an unknown initial activity", () => {
    expect(serviceSchemaProblems(copy(m => { branch(m, "P-RES-ok").service.default.op = "restart"; }))).toEqual(["P-RES-ok/default: unknown operation restart"]);
    expect(serviceSchemaProblems(copy(m => { branch(m, "P-RES-ok").service.default.before = "running"; }))).toEqual(["P-RES-ok/default: unknown initial activity running"]);
  });
  it("rejects an absent default and an unknown field", () => {
    expect(serviceSchemaProblems(copy(m => { const s = branch(m, "P-RES-copy").service; s.other = s.default; delete s.default; }))).toEqual(["P-RES-copy: no default service variant"]);
    expect(serviceSchemaProblems(copy(m => { branch(m, "P-RES-ok").service.default.extra = 1; }))).toEqual(["P-RES-ok/default: unknown field extra"]);
  });
  it("rejects a via row whose guard has no service declaration", () => {
    const problems = serviceSchemaProblems(copy(m => { delete m.GUARDS.find(g => g.id === "G2.prepare").service; }));
    expect(problems).toContain("P-UPD: referenced guard G2.prepare has no service declaration");
    expect(problems).toContain("G2.prepare: no service declaration");
  });
  it("rejects a declared variant without a recipe and a recipe variant that is undeclared", () => {
    expect(correspondence(copy(m => { branch(m, "P-RES-ok").service.inactive = { before: "inactive", op: "start" }; }), RECIPES, PRECONDITIONS)).toEqual(["P-RES-ok: declared variant inactive has no recipe"]);
    expect(correspondence(copy(m => { delete branch(m, "P-RES-copy").service.inactive; }), RECIPES, PRECONDITIONS)).toEqual(["P-RES-copy: recipe variant inactive is undeclared"]);
  });
  it("rejects a variant precondition that has no check, and a check that nothing uses", () => {
    expect(correspondence(copy(m => { branch(m, "P-RES-copy").service.inactive.pre = "no-such-check"; }), RECIPES, PRECONDITIONS)).toEqual(["no precondition no-such-check"]);
    expect(correspondence(copy(() => {}), RECIPES, { ...PRECONDITIONS, unused: () => true })).toEqual(["precondition unused is not used"]);
  });
});
