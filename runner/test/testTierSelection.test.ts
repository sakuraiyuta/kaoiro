import "../../scripts/test/fixtures/test-isolation.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareSelections, loadTiers, TIERS } from "../scripts/tier-selection.mjs";

// What Vitest actually selects for each KAOIRO_RUNNER_TIER value, compared with
// runner/test-tiers.json. A declared file that a selection omits (for example a
// name Vitest excludes by default) or an undeclared file that integration or
// native selects fails here by name. It starts Vitest, so it is an integration test.
const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..");

function files(out: string): string[] {
  return (JSON.parse(out) as { file: string }[]).map(row => relative(RUNNER, row.file).split("\\").join("/")).sort();
}

function selected(tier: string): string[] {
  return files(execFileSync(join(RUNNER, "node_modules/.bin/vitest"), ["list", "--json", "--filesOnly"], {
    cwd: RUNNER, encoding: "utf8", env: { ...process.env, KAOIRO_RUNNER_TIER: tier }, maxBuffer: 64 * 1024 * 1024,
  }));
}

// The launch a package script performs, with its final `vitest run` turned into a
// listing, run by a shell with the selector a caller may have inherited.
const SCRIPTS = JSON.parse(readFileSync(join(RUNNER, "package.json"), "utf8")).scripts as Record<string, string>;
function viaScript(name: string, inherited: string): string[] {
  const body = SCRIPTS[name] ?? "";
  expect(body, `script ${name}`).toMatch(/^pnpm build && (?:KAOIRO_RUNNER_TIER=\w+ )?vitest run$/);
  const command = body.replace(/^pnpm build && /, "").replace(/vitest run$/, "vitest list --json --filesOnly");
  return files(execFileSync("sh", ["-c", command], {
    cwd: RUNNER, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PATH: `${join(RUNNER, "node_modules/.bin")}:${process.env.PATH}`, KAOIRO_RUNNER_TIER: inherited },
  }));
}

describe("runner test tiers", () => {
  it("keeps native-state recovery in integration and outside fast",()=>{
    expect(selected("integration")).toContain("test/codexStateRecovery.test.ts");
    expect(selected("fast")).not.toContain("test/codexStateRecovery.test.ts");
  },30_000);

  it("select what runner/test-tiers.json declares, and the tiers partition the complete selection", () => {
    expect(TIERS).toEqual(["complete", "fast", "integration", "native"]);
    const [complete, fast, integration, native] = TIERS.map(selected);
    expect(compareSelections({ complete, fast, integration, native, declared: loadTiers(RUNNER) } as never)).toEqual([]);
  }, 120_000);

  const scripts: [string, string][] = [["test", "complete"], ["test:fast", "fast"], ["test:integration", "integration"], ["test:native", "native"]];
  for (const [name, tier] of scripts) {
    it(`${name} selects the ${tier} selection whatever selector the caller inherited`, () => {
      const expected = selected(tier);
      for (const inherited of ["fast", "native", "zzz"]) expect(viaScript(name, inherited), `inherited ${inherited}`).toEqual(expected);
    }, 120_000);
  }
});
