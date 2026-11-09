import "./isolation.setup";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The en tables are checked as whole files, comments included. Types cannot
// see a Japanese string left in an English table, and a screen test only sees
// the strings it draws.
const EN_DIR = join(import.meta.dirname, "../src/lib/i18n/en");
const JAPANESE = /[ぁ-んァ-ヶ一-龠々〆ー]/;

function enFiles(): string[] {
  return readdirSync(EN_DIR).filter((name) => name.endsWith(".ts"));
}

describe("en tables (issue #269)", () => {
  it("covers every area of the ja tables", () => {
    const ja = readdirSync(join(EN_DIR, "../ja")).filter((n) => n.endsWith(".ts"));
    expect(enFiles().length).toBeGreaterThan(0);
    for (const name of ja) expect(enFiles()).toContain(name);
  });

  it("contains no Japanese text", () => {
    const files = enFiles();
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((name) =>
      JAPANESE.test(readFileSync(join(EN_DIR, name), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
