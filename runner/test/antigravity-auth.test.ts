import "../../scripts/test/fixtures/test-isolation.mjs";
import { execFileSync } from "node:child_process";
import {
  accessSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { antigravityAuthProblem, parseAntigravityAuth } from "../src/antigravity-auth.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, accessSync: vi.fn(fs.accessSync), openSync: vi.fn(fs.openSync),
    readFileSync: vi.fn(fs.readFileSync) };
});

describe("Antigravity credential markers", () => {
  let home: string;
  let file: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agy-auth-"));
    file = join(home, "credentials");
    writeFileSync(file, "test credential contents");
    env = { HOME: home, AGY_ADC_AUTH: "true", GOOGLE_APPLICATION_CREDENTIALS: file };
    vi.clearAllMocks();
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const check = () => antigravityAuthProblem("google-cloud-adc", home, env);

  it("follows readable regular files without reading their contents", () => {
    const link = join(home, "link");
    symlinkSync(file, link);
    env.GOOGLE_APPLICATION_CREDENTIALS = "link";
    expect(check()).toBeNull();
    expect(accessSync).toHaveBeenCalledWith(link, expect.any(Number));
    expect(openSync).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
    closeSync(openSync(link, "r"));
    expect(openSync).toHaveBeenCalledWith(link, "r");
    readFileSync(link);
    expect(readFileSync).toHaveBeenCalledWith(link);
  });

  it.each(["misspelled", null, 73])(
    "refuses declaration %j even with usable ADC credentials", (value) => {
      expect(check()).toBeNull();
      const auth = parseAntigravityAuth(value);
      expect(auth).toBe("invalid");
      expect(antigravityAuthProblem(auth, home, env))
        .toBe("unsupported antigravity.auth declaration");
    },
  );

  it("resolves relative sources from the child cwd without collapsing symlinks", () => {
    mkdirSync(join(home, "other", "child"), { recursive: true });
    symlinkSync(join(home, "other", "child"), join(home, "link"));
    env.GOOGLE_APPLICATION_CREDENTIALS = "link/../credentials";
    expect(check()).not.toBeNull();
    writeFileSync(join(home, "other", "credentials"), "");
    expect(check()).toBeNull();
  });

  it("checks the default ADC file only when the explicit source is absent", () => {
    delete env.GOOGLE_APPLICATION_CREDENTIALS;
    expect(check()).not.toBeNull();
    const dir = join(home, ".config", "gcloud");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "application_default_credentials.json"), "");
    expect(check()).toBeNull();
    env.GOOGLE_APPLICATION_CREDENTIALS = "";
    expect(check()).not.toBeNull();
    env.GOOGLE_APPLICATION_CREDENTIALS = join(home, "missing");
    expect(check()).not.toBeNull();
  });

  it("refuses missing markers and unreadable or non-regular sources", () => {
    expect(antigravityAuthProblem(undefined, home, env)).not.toBeNull();
    for (const flag of ["false", "", "TRUE", undefined]) {
      expect(antigravityAuthProblem("google-cloud-adc", home,
        { ...env, AGY_ADC_AUTH: flag })).not.toBeNull();
    }
    expect(antigravityAuthProblem("google-cloud-adc", home,
      { ...env, HOME: undefined })).not.toBeNull();
    vi.mocked(accessSync).mockImplementationOnce(() => { throw new Error("EACCES"); });
    expect(check()).not.toBeNull();
    const broken = join(home, "broken");
    symlinkSync(join(home, "missing"), broken);
    for (const path of [broken, home]) {
      env.GOOGLE_APPLICATION_CREDENTIALS = path;
      expect(check()).not.toBeNull();
    }
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO and a socket", async () => {
    const fifo = join(home, "fifo");
    execFileSync("mkfifo", [fifo]);
    env.GOOGLE_APPLICATION_CREDENTIALS = fifo;
    expect(check()).not.toBeNull();
    const server = createServer();
    const sock = join(home, "sock");
    await new Promise<void>((ok, fail) => server.once("error", fail).listen(sock, ok));
    try {
      env.GOOGLE_APPLICATION_CREDENTIALS = sock;
      expect(check()).not.toBeNull();
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });

  it("accepts the sign-in declaration and refuses a key with either method", () => {
    expect(antigravityAuthProblem("google-cloud-sign-in", home,
      { HOME: home })).toBeNull();
    env.GEMINI_API_KEY = "fixture-marker-value";
    for (const method of ["google-cloud-sign-in", "google-cloud-adc"] as const) {
      const error = antigravityAuthProblem(method, home, env);
      expect(error).toContain("GEMINI_API_KEY");
      expect(error).not.toContain(env.GEMINI_API_KEY);
    }
  });
});
