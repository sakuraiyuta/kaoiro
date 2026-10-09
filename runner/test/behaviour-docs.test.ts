import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BEHAVIOUR_ROWS,
  HOST_DELIVERY_ROWS,
  behaviourConfigPath,
} from "../src/behaviour-settings.js";

const RUNNER_DOC = new URL(
  "../../docs/reference/configuration/runner.md",
  import.meta.url,
);

function documentedRows(): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const line of readFileSync(RUNNER_DOC, "utf8").split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    const variable = /^`(KAOIRO_[A-Z0-9_]+)`$/.exec(cells[1] ?? "");
    const key = /^`([a-z0-9_.]+)`$/.exec(cells[2] ?? "");
    if (variable !== null && key !== null) {
      rows.push([variable[1]!, key[1]!]);
    }
  }
  return rows;
}

describe("runner.md behaviour settings table", () => {
  it("lists every registry row, with the same variable and config key, and nothing else", () => {
    expect(documentedRows()).toEqual(
      BEHAVIOUR_ROWS.map((row) => [row.env, behaviourConfigPath(row)]),
    );
  });
});


describe("host delivery registry documentation", () => {
  it("pins canonical engine prefixes and independently resolved defaults", () => {
    const rows = readFileSync(RUNNER_DOC, "utf8").split("\n").filter(line => line.includes("| `in_flight_delivery."));
    expect(rows).toEqual(HOST_DELIVERY_ROWS.map(row =>
      `| \`${row.engine}\` | \`in_flight_delivery.${row.engine}\` | \`${row.enabled}\` | \`${row.default}\` |`));
  });
});
