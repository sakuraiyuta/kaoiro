import "../../../scripts/test/fixtures/test-isolation.mjs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PermissionBroker } from "@kaoiro/agent-common";
import { AcpToolPolicy, type AntigravityLaunchConfig, type HookToolCall } from "../src/gate.js";

type Sandbox = NonNullable<AntigravityLaunchConfig["sandbox"]>;
type Approval = NonNullable<AntigravityLaunchConfig["approval"]>;
const APPROVALS: readonly Approval[] = ["untrusted", "on-request", "local", "on-failure", "never"];

let root: string;
let cwd: string;
let customizationDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "agy-acp-policy-test-"));
  cwd = join(root, "workspace");
  customizationDir = join(root, "custom");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  mkdirSync(customizationDir);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function config(sandbox: Sandbox, approval: Approval, network: boolean): AntigravityLaunchConfig {
  return {
    agent_id: "a1",
    persona: { id: "momo", name: "もも", sprite_set: "momo" },
    display_name: "もも",
    server_url: "ws://localhost:4000",
    sandbox,
    approval,
    network_access: network,
  };
}

function policy(sandbox: Sandbox, approval: Approval, network: boolean, broker?: PermissionBroker): AcpToolPolicy {
  const launch = config(sandbox, approval, network);
  return new AcpToolPolicy({
    config: launch,
    cwd,
    customizationDir,
    kaoiroToolNames: () => new Set(["whoami"]),
    broker: broker ?? new PermissionBroker({ config: launch, send: () => {} }),
  });
}

/** One representative call per row of the design's section 4.2 table. */
function calls(): Record<string, HookToolCall> {
  return {
    read: { name: "read_file", args: { Path: join(cwd, "a.txt") } },
    readTask: { name: "manage_task", args: { Action: "status" } },
    writeIn: { name: "write_file", args: { Path: join(cwd, "a.txt"), Content: "x" } },
    writeOut: { name: "write_file", args: { Path: join(root, "out.txt"), Content: "x" } },
    writeGit: { name: "write_file", args: { Path: join(cwd, ".git", "config"), Content: "x" } },
    shell: { name: "run_command", args: { CommandLine: "make deploy", Cwd: "/" } },
    shellLocal: { name: "run_command", args: { CommandLine: "ls", Cwd: cwd } },
    bypass: { name: "run_command", args: { CommandLine: "make deploy", BypassSandbox: true } },
    network: { name: "search_web", args: { query: "kaoiro" } },
    subagent: { name: "invoke_subagent", args: { TypeName: "helper", Prompt: "p" } },
    unknown: { name: "swarm", args: {} },
    otherMcp: { name: "mcp_other_tool", args: {} },
    unregisteredKaoiro: { name: "mcp_kaoiro_nosuch", args: {} },
    kaoiro: { name: "mcp_kaoiro_whoami", args: {} },
    internal: { name: "send_message", args: { Recipient: "x" } },
  };
}

/** Expected letter per approval, in the order of APPROVALS: A allow, Q ask,
 *  D deny. Written from the design table, not derived from the code. */
const EXPECTED: Record<string, Record<string, string>> = {
  "read-only/off": {
    read: "AAAAA", readTask: "AAAAA", writeIn: "DDDDD", writeOut: "DDDDD", writeGit: "DDDDD",
    shell: "DDDDD", shellLocal: "DDDDD", bypass: "DDDDD", network: "DDDDD", subagent: "DDDDD",
    unknown: "DDDDD", otherMcp: "DDDDD", unregisteredKaoiro: "DDDDD", kaoiro: "AAAAA", internal: "DDDDD",
  },
  "read-only/on": {
    read: "AAAAA", readTask: "AAAAA", writeIn: "DDDDD", writeOut: "DDDDD", writeGit: "DDDDD",
    shell: "DDDDD", shellLocal: "DDDDD", bypass: "DDDDD", network: "DDDDD", subagent: "DDDDD",
    unknown: "DDDDD", otherMcp: "DDDDD", unregisteredKaoiro: "DDDDD", kaoiro: "AAAAA", internal: "DDDDD",
  },
  "workspace-write/off": {
    read: "AAAAA", readTask: "AAAAA", writeIn: "QAAAA", writeOut: "DDDDD", writeGit: "QAQAA",
    shell: "DDDDD", shellLocal: "DDDDD", bypass: "DDDDD", network: "DDDDD", subagent: "DDDDD",
    unknown: "QQQQD", otherMcp: "QQQQD", unregisteredKaoiro: "QQQQD", kaoiro: "AAAAA", internal: "DDDDD",
  },
  "workspace-write/on": {
    read: "AAAAA", readTask: "AAAAA", writeIn: "QAAAA", writeOut: "DDDDD", writeGit: "QAQAA",
    shell: "QQQQD", shellLocal: "QQQQD", bypass: "QQQQD", network: "QQQQD", subagent: "QQQQD",
    unknown: "QQQQD", otherMcp: "QQQQD", unregisteredKaoiro: "QQQQD", kaoiro: "AAAAA", internal: "DDDDD",
  },
  "danger-full-access/off": {
    read: "AAAAA", readTask: "AAAAA", writeIn: "QAAAA", writeOut: "QAAAA", writeGit: "QAQAA",
    shell: "QQQQA", shellLocal: "QQAQA", bypass: "QQQQA", network: "QQQQA", subagent: "QQQQA",
    unknown: "QQQQD", otherMcp: "QQQQD", unregisteredKaoiro: "QQQQD", kaoiro: "AAAAA", internal: "DDDDD",
  },
  "danger-full-access/on": {
    read: "AAAAA", readTask: "AAAAA", writeIn: "QAAAA", writeOut: "QAAAA", writeGit: "QAQAA",
    shell: "QQQQA", shellLocal: "QQAQA", bypass: "QQQQA", network: "QQQQA", subagent: "QQQQA",
    unknown: "QQQQD", otherMcp: "QQQQD", unregisteredKaoiro: "QQQQD", kaoiro: "AAAAA", internal: "DDDDD",
  },
};

const LETTER = { allow: "A", ask: "Q", deny: "D" } as const;

describe("AcpToolPolicy: the section 4.2 cells", () => {
  for (const [key, rows] of Object.entries(EXPECTED)) {
    const [sandbox, net] = key.split("/") as [Sandbox, "on" | "off"];
    it(`${key}: every class and approval`, () => {
      const actual: Record<string, string> = {};
      for (const [row, call] of Object.entries(calls())) {
        actual[row] = APPROVALS.map((approval) => LETTER[policy(sandbox, approval, net === "on").evaluate(call).decision]).join("");
      }
      expect(actual).toEqual(rows);
    });
  }
});

describe("AcpToolPolicy: evaluation order and reasons", () => {
  it("denies a malformed read_file before anything else, even where everything else is allowed", () => {
    const gate = policy("danger-full-access", "never", true);
    expect(gate.evaluate({ name: "read_file", args: {} })).toEqual({
      decision: "deny", reason: "kaoiro: read_file argument is missing or malformed",
    });
    expect(gate.evaluate({ name: "read_file", args: { Path: join(cwd, "a"), Extra: 1 } }).decision).toBe("deny");
  });

  it("denies a write without a parseable target: write_file and edit_file take Path", () => {
    const gate = policy("danger-full-access", "never", true);
    const malformed = { decision: "deny", reason: "kaoiro: write target is missing or malformed" };
    expect(gate.evaluate({ name: "write_file", args: { Content: "x" } })).toEqual(malformed);
    expect(gate.evaluate({ name: "edit_file", args: { TargetFile: join(cwd, "a") } })).toEqual(malformed);
    expect(gate.evaluate({ name: "write_file", args: { Path: 7 } })).toEqual(malformed);
    expect(gate.evaluate({ name: "write_file", args: { Path: join(cwd, "a"), AbsolutePath: 7, Content: "x" } })).toEqual(malformed);
    expect(gate.evaluate({ name: "edit_file", args: { Path: join(cwd, "a") } })).toEqual({ decision: "allow" });
  });

  it("decides edit_file with its measured arguments (Path, Replacement, Target) as a write to Path", () => {
    // The argument names and types of the 1.5.14 hook requests in the
    // implementation-review native runs (read-only and workspace-write).
    const edit = (path: string) => ({ name: "edit_file", args: { Path: path, Replacement: "goodbye", Target: "hello" } });
    expect(policy("read-only", "never", false).evaluate(edit(join(cwd, "a.txt")))).toEqual({ decision: "deny", reason: "kaoiro: read-only sandbox" });
    expect(policy("workspace-write", "on-request", false).evaluate(edit(join(cwd, "a.txt")))).toEqual({ decision: "allow" });
    expect(policy("workspace-write", "on-request", false).evaluate(edit(join(root, "outside.txt")))).toEqual({
      decision: "deny", reason: "kaoiro: write is outside the permitted workspace",
    });
    expect(policy("workspace-write", "on-request", false).evaluate({ name: "edit_file", args: { Replacement: "goodbye", Target: "hello" } })).toEqual({
      decision: "deny", reason: "kaoiro: write target is missing or malformed",
    });
  });

  it("protects the customization directory through any path argument, a command's Cwd included", () => {
    const protectedReason = { decision: "deny", reason: "kaoiro: customization directory is protected" };
    const gate = policy("danger-full-access", "never", true);
    expect(gate.evaluate({ name: "run_command", args: { CommandLine: "ls", Cwd: customizationDir } })).toEqual(protectedReason);
    expect(gate.evaluate({ name: "generate_image", args: { Path: join(customizationDir, "x.png") } })).toEqual(protectedReason);
    expect(gate.evaluate({ name: "invoke_subagent", args: { Prompt: `edit ${customizationDir}/.agents/hooks.json`, CommandLine: `cat ${customizationDir}` } }))
      .toEqual(protectedReason);
  });

  it("does not take another prefix of the same length for the kaoiro prefix", () => {
    expect(policy("workspace-write", "on-request", true).evaluate({ name: "mcp_other__whoami", args: {} })).toEqual({ decision: "ask" });
    expect(policy("read-only", "on-request", true).evaluate({ name: "mcp_other__whoami", args: {} })).toEqual({
      decision: "deny", reason: "kaoiro: unclassified tool denied",
    });
  });

  it("uses the local allowlist only for run_command with a command line", () => {
    const gate = policy("danger-full-access", "local", true);
    expect(gate.evaluate({ name: "run_command", args: {} })).toEqual({ decision: "ask" });
    expect(gate.evaluate({ name: "run_command", args: { CommandLine: 7 } })).toEqual({ decision: "ask" });
    expect(gate.evaluate({ name: "send_command_input", args: { CommandLine: "ls" } })).toEqual({ decision: "ask" });
    expect(gate.evaluate({ name: "run_command", args: { CommandLine: "ls" } })).toEqual({ decision: "allow" });
  });

  it("protects the customization directory for reads, writes and commands in every cell", () => {
    const protectedReason = { decision: "deny", reason: "kaoiro: customization directory is protected" };
    for (const sandbox of ["read-only", "workspace-write", "danger-full-access"] as const) {
      const gate = policy(sandbox, "never", true);
      expect(gate.evaluate({ name: "read_file", args: { Path: join(customizationDir, "hooks.json") } })).toEqual(protectedReason);
      expect(gate.evaluate({ name: "run_command", args: { CommandLine: `cat ${customizationDir}/x` } })).toEqual(protectedReason);
    }
    expect(policy("danger-full-access", "never", true).evaluate({
      name: "write_file", args: { Path: join(customizationDir, "x"), Content: "x" },
    })).toEqual(protectedReason);
  });

  it("denies agent-internal tools with their own reason, also where the shell column allows", () => {
    expect(policy("danger-full-access", "never", true).evaluate({ name: "run_workflow", args: {} })).toEqual({
      decision: "deny", reason: "kaoiro: tool is not available through kaoiro",
    });
  });

  it("allows a registered kaoiro tool before the network check and the cell", () => {
    expect(policy("workspace-write", "never", false).evaluate({ name: "mcp_kaoiro_whoami", args: {} })).toEqual({ decision: "allow" });
    expect(policy("read-only", "untrusted", false).evaluate({ name: "mcp_kaoiro_whoami", args: {} })).toEqual({ decision: "allow" });
  });

  it("names the reason for each kind of deny", () => {
    expect(policy("workspace-write", "on-request", false).evaluate(calls().network!)).toEqual({
      decision: "deny", reason: "kaoiro: network access is disabled",
    });
    expect(policy("workspace-write", "on-request", false).evaluate(calls().shell!)).toEqual({
      decision: "deny", reason: "kaoiro: this tool needs network access in workspace-write",
    });
    expect(policy("workspace-write", "never", true).evaluate(calls().shell!)).toEqual({
      decision: "deny", reason: "kaoiro: approval policy never denies this tool",
    });
    expect(policy("workspace-write", "on-request", true).evaluate(calls().writeOut!)).toEqual({
      decision: "deny", reason: "kaoiro: write is outside the permitted workspace",
    });
    expect(policy("read-only", "on-request", true).evaluate(calls().shell!)).toEqual({
      decision: "deny", reason: "kaoiro: read-only sandbox",
    });
    expect(policy("read-only", "on-request", true).evaluate(calls().unknown!)).toEqual({
      decision: "deny", reason: "kaoiro: unclassified tool denied",
    });
  });

  it("does not read Cwd: a command is decided the same wherever it says it runs", () => {
    for (const sandbox of ["workspace-write", "danger-full-access"] as const) {
      for (const approval of APPROVALS) {
        const gate = policy(sandbox, approval, true);
        const inside = gate.evaluate({ name: "run_command", args: { CommandLine: "ls", Cwd: cwd } });
        const outside = gate.evaluate({ name: "run_command", args: { CommandLine: "ls", Cwd: "/" } });
        const none = gate.evaluate({ name: "run_command", args: { CommandLine: "ls" } });
        expect(outside).toEqual(inside);
        expect(none).toEqual(inside);
      }
    }
  });
});

describe("AcpToolPolicy.decide", () => {
  it("asks the operator through the broker with the hook's signal and maps the answer", async () => {
    const decide = vi.fn(async () => ({ allow: false, message: "no thanks" }));
    const gate = policy("workspace-write", "on-request", true, { decide } as unknown as PermissionBroker);
    const signal = new AbortController().signal;
    await expect(gate.decide(calls().shell!, signal)).resolves.toEqual({ decision: "deny", reason: "no thanks" });
    expect(decide).toHaveBeenCalledWith("run_command", calls().shell!.args, signal);
    decide.mockResolvedValueOnce({ allow: true, message: undefined as never });
    await expect(gate.decide(calls().shell!, signal)).resolves.toEqual({ decision: "allow" });
  });

  it("does not ask for a decided cell", async () => {
    const decide = vi.fn();
    const gate = policy("workspace-write", "on-request", false, { decide } as unknown as PermissionBroker);
    await expect(gate.decide(calls().shell!)).resolves.toMatchObject({ decision: "deny" });
    await expect(gate.decide(calls().read!)).resolves.toEqual({ decision: "allow" });
    expect(decide).not.toHaveBeenCalled();
  });

  it("denies without a dialog when the hook connection already closed", async () => {
    const launch = config("workspace-write", "on-request", true);
    const sent: unknown[] = [];
    const gate = policy("workspace-write", "on-request", true, new PermissionBroker({ config: launch, send: (e) => sent.push(e) }));
    const closed = new AbortController();
    closed.abort();
    await expect(gate.decide(calls().shell!, closed.signal)).resolves.toMatchObject({ decision: "deny" });
    expect(sent).toEqual([]);
  });
});
