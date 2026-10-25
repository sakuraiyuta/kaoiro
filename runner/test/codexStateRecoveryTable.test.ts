import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scan, shellLines, type Scan } from "./codexStateRecoveryScan.js";
import { EXCLUDED, PRECONDITIONS, PROTECTED, RECIPES } from "./codexStateRecoveryRecipes.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const deploy = join(repo, "runner/deploy");
const recovery: any = await import(pathToFileURL(join(deploy, "codex-state-recovery.mjs")).href);
const SHELL = ["kaoiro-runner-update.sh", "kaoiro-runner-switch.sh", "kaoiro-runner-install.sh", "kaoiro-runner-common.sh"];
const { ANCHORS, CAUSAL, CLASSES, COMMANDS, GUARDS, LABELS, OUTCOMES, PHASES, REFUSALS, RETHROWS, SHARED_MESSAGES, SHELL_REFUSALS, TABLE } = recovery;
const FIELDS = {
  branch: ["id", "cmds", "outcome", "pre", "message", "class", "site", "pin", "final"],
  via: ["id", "cmds", "guard"],
  guard: ["id", "messages", "class", "pin"],
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

export function correspondence(m: any, recipes: Record<string, unknown>, preconditions: Record<string, unknown>) {
  const problems: string[] = [];
  const ids = [...m.branches().filter((x: any) => !x.guard).map((x: any) => x.id), ...m.GUARDS.map((g: any) => g.id)];
  for (const id of ids) if (!Object.hasOwn(recipes, id)) problems.push(`no recipe for ${id}`);
  for (const id of Object.keys(recipes)) if (!ids.includes(id)) problems.push(`recipe for undeclared ${id}`);
  const names = new Set(m.branches().map((x: any) => x.pre).filter(Boolean));
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
  it("matches the layer-2 recipes and preconditions both ways", () => {
    expect(correspondence(recovery, RECIPES, PRECONDITIONS)).toEqual([]);
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
  it("keeps the generated runbook table", () => {
    const text = readFileSync(join(repo, "docs/operations/runner-update-and-rollback.md"), "utf8");
    const generated = text.split("<!-- recovery-table:begin -->")[1]?.split("<!-- recovery-table:end -->")[0]?.trim();
    expect(generated).toBe(recovery.runbook());
  });
  it("never excludes protected state from the zero-mutation digest", () => {
    for (const path of EXCLUDED) for (const root of PROTECTED) expect(path === root || path.startsWith(root.endsWith("-") ? root : root + "/"), `${path} under ${root}`).toBe(false);
  });
});
