import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppServerTransport } from "../src/app_server_transport.js";

// The real pinned CLI exits with the retry signature when its sqlite state
// cannot be opened. Making `state_5.sqlite` a directory reproduces that
// deterministically (the two-child race that produces it in production is
// probabilistic and stays out of CI; see docs/evidence/codex-app-server).
let home = "";
let state = "";
const opened: AppServerTransport[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ao411-init-"));
  state = join(home, "state_5.sqlite");
  mkdirSync(state);
  vi.stubEnv("CODEX_HOME", home);
  vi.stubEnv("HOME", home);
  for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"]) vi.stubEnv(name, undefined);
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map(transport => transport.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

it("recovers on the second attempt once the state can be opened", async () => {
  const diagnostics: string[] = [];
  const disconnects: Error[] = [];
  const transport = new AppServerTransport({
    onDiagnostic: message => {
      diagnostics.push(message);
      // The retry line is written before the wait: the second child finds a usable home.
      rmSync(state, { recursive: true, force: true });
    },
    onDisconnect: error => disconnects.push(error),
  });
  opened.push(transport);
  await transport.readRateLimits();
  expect(transport.version, "premise: the second child answered initialize").toMatch(/^\d+\.\d+\.\d+/);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toContain(`failed to initialize sqlite state runtime under ${home}`);
  expect(disconnects).toEqual([]);
}, 60_000);

it("gives up after three attempts when the state stays unusable", async () => {
  const diagnostics: string[] = [];
  const transport = new AppServerTransport({ onDiagnostic: message => diagnostics.push(message) });
  opened.push(transport);
  const error = await transport.readRateLimits().then(() => undefined, (caught: Error) => caught);
  expect(error?.message).toContain("initialize attempt 3/3");
  expect(error?.message).toContain(`failed to initialize sqlite state runtime under ${home}`);
  expect(diagnostics).toHaveLength(2);
}, 60_000);
