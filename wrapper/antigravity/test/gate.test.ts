import "../../../scripts/test/fixtures/test-isolation.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionBroker } from "@kaoiro/agent-common";
import { AcpToolPolicy, type AntigravityLaunchConfig } from "../src/gate.js";

function config(overrides: Partial<AntigravityLaunchConfig> = {}): AntigravityLaunchConfig {
  return {
    agent_id: "a1",
    persona: { id: "momo", name: "もも", sprite_set: "momo" },
    display_name: "もも",
    server_url: "ws://localhost:4000",
    sandbox: "workspace-write",
    approval: "on-request",
    network_access: false,
    ...overrides,
  };
}

function makeGate(overrides: Partial<AntigravityLaunchConfig> = {}, omitApproval = false) {
  const root = mkdtempSync(join(tmpdir(), "agy-gate-test-"));
  const cwd = join(root, "workspace");
  const customizationDir = join(root, "custom");
  mkdirSync(cwd);
  mkdirSync(customizationDir);
  const configured = config(overrides);
  const { approval: _approval, ...withoutApproval } = configured;
  const launchConfig = omitApproval ? withoutApproval : configured;
  const gate = new AcpToolPolicy({
    config: launchConfig,
    cwd,
    customizationDir,
    kaoiroToolNames: () => new Set(["whoami"]),
    broker: new PermissionBroker({ config: launchConfig, send: () => {} }),
  });
  return { gate, root, cwd, customizationDir };
}

// The path and command helpers behind the policy's read, write and local
// allowlist decisions; the class-by-cell table is in acp_tool_policy.test.ts.
describe("AcpToolPolicy path and command checks", () => {
  it("validates read_file arguments before customization-directory protection", () => {
    const { gate, root, cwd, customizationDir } = makeGate({ approval: "never", network_access: true });
    try {
      for (const args of [
        {},
        { Path: "" },
        { Path: 42 },
        { Path: join(cwd, "README.md"), StartLine: 1.5 },
        { Path: join(cwd, "README.md"), EndLine: "2" },
        { Path: join(cwd, "README.md"), ByteOffset: -1 },
        { Path: join(cwd, "README.md"), ByteOffset: 1.25 },
        { path: join(cwd, "README.md") },
        { Path: join(cwd, "README.md"), Unexpected: true },
        { Path: join(customizationDir, "settings.json"), StartLine: "invalid" },
      ]) {
        expect(gate.evaluate({ name: "read_file", args })).toEqual({
          decision: "deny",
          reason: "kaoiro: read_file argument is missing or malformed",
        });
      }
      expect(gate.evaluate({ name: "read_file", args: null as never })).toEqual({
        decision: "deny",
        reason: "kaoiro: read_file argument is missing or malformed",
      });
      expect(gate.evaluate({ name: "read_file", args: [] as never })).toEqual({
        decision: "deny",
        reason: "kaoiro: read_file argument is missing or malformed",
      });

      for (const args of [
        { Path: join(cwd, "README.md") },
        { Path: join(cwd, "README.md"), StartLine: 1, EndLine: 8 },
        { Path: join(cwd, "README.md"), ByteOffset: 0 },
        { Path: join(cwd, "README.md"), ByteOffset: 4096 },
      ]) {
        expect(gate.evaluate({ name: "read_file", args })).toEqual({ decision: "allow" });
      }

      expect(gate.evaluate({ name: "read_file", args: { Path: join(customizationDir, "settings.json") } })).toEqual({
        decision: "deny",
        reason: "kaoiro: customization directory is protected",
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("defaults to on-request and does not silently enable local commands", () => {
    const { gate, root, cwd } = makeGate({ sandbox: "danger-full-access" }, true);
    try {
      expect(gate.evaluate({
        name: "run_command",
        args: { CommandLine: "git status" },
      })).toEqual({ decision: "ask" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    "pwd",
    "ls -la .",
    "cat README.md",
    "cat ./~x",
    "head -n 5 README.md",
    "tail -n 5 README.md",
    "wc -l README.md",
    "stat README.md",
    "file README.md",
    "git status --short",
    "git diff --stat",
    "git diff --name-only --patch README.md",
    "git diff --cached --staged --numstat --shortstat -w --ignore-all-space -M -C -U3 --unified README.md",
    "git diff -- README.md",
    "git diff HEAD~1 HEAD",
    "git log --oneline",
    "git log -5 --graph --decorate HEAD",
    "git log --author momo --grep=fix --since yesterday --until=today -n 5 HEAD",
    "git log --max-count=5 --name-status HEAD",
    "git log HEAD",
    "git log HEAD~2",
    "git log main",
    "git log main..dev",
    "git log main...dev",
    "git show HEAD",
    "git show -n1 --stat HEAD",
    "git show HEAD~2",
    "git show HEAD:README.md",
    "git --no-pager diff --stat",
    "git rev-parse HEAD",
    "git describe --always",
    "git ls-files",
    "git ls-tree HEAD",
    "git cat-file -t HEAD",
    "git branch --list feature",
    "git tag --list v1",
    "git worktree list --porcelain",
    "git add README.md",
    "git status && git diff",
    "cat README.md | wc -l README.md",
    "cat future.txt",
  ])("local approval allows a classified local command: %s", (command) => {
    const { gate, root, cwd } = makeGate({ sandbox: "danger-full-access", approval: "local" });
    try {
      writeFileSync(join(cwd, "README.md"), "hello\n");
      expect(gate.evaluate({
        name: "run_command",
        args: { CommandLine: command },
      })).toEqual({ decision: "allow" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    "git fetch origin",
    "git push origin main",
    "git pull",
    "git clone https://example.invalid/repo",
    "git ls-remote origin",
    "git remote -v",
    "git submodule update --init",
    "git -C other status",
    "git -c alias.x=!curl x",
    "git --git-dir=.git status",
    "git --work-tree=. status",
    "git clean -fdx",
    "git reset --hard",
    "git restore .",
    "git checkout -- .",
    "git switch main",
    "git rebase --exec id main",
    "git config alias.x !curl",
    "git future-command",
    "git diff /etc/passwd /dev/null",
    "git diff --no-index a b",
    "git diff - README.md",
    "git diff -- sub/../../x",
    "git show HEAD:/etc/passwd",
    "git log main....dev",
    "git log HEAD~x",
    "git diff --ext-diff",
    "git diff --output=/tmp/diff",
    "git diff --future-safe-option",
    "git diff -Oorderfile",
    "git log -L 1,5:README.md",
    "git log --textconv",
    "git add /tmp/outside",
    "git add :/",
    "git add ~/x",
    "git branch --list -D main",
    "git tag -l -f v1 HEAD",
    "git commit -m x",
    "git merge feature",
    "git commit --template /tmp/template",
    "pnpm test",
    "pnpm install",
    "curl https://example.invalid",
    "wget https://example.invalid",
    "ssh example.invalid",
    "scp a example.invalid:b",
    "rm -rf build",
    "chmod 777 README.md",
    "sudo id",
    "env FOO=bar git status",
    "FOO=bar git status",
    "echo $HOME",
    "git status || git diff",
    "git status; git diff",
    "git status && git fetch",
    "git status | curl example.invalid",
    "$(git status)",
    "(git status)",
    "eval git status",
    "git　status",
    "cat ~/x",
    "ls ~",
    "cat ~user/x",
  ])("local approval asks for an unclassified or elevated command: %s", (command) => {
    const { gate, root, cwd } = makeGate({ sandbox: "danger-full-access", approval: "local", network_access: true });
    try {
      expect(gate.evaluate({
        name: "run_command",
        args: { CommandLine: command },
      })).toEqual({ decision: "ask" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("local approval asks before writes to Git metadata", () => {
    const { gate, root, cwd } = makeGate({ approval: "local" });
    try {
      mkdirSync(join(cwd, ".git"));
      mkdirSync(join(cwd, ".git", "hooks"));
      symlinkSync(join(cwd, ".git"), join(cwd, "g"));
      for (const [name, args] of [
        ["write_to_file", { TargetFile: join(cwd, ".git", "config") }],
        ["replace_file_content", { AbsolutePath: join(cwd, ".git", "hooks", "pre-commit") }],
        ["multi_replace_file_content", { TargetFile: join(cwd, ".git", "..", ".git", "config") }],
        ["sed_file", { TargetFile: join(cwd, "g", "config") }],
        ["notebook_edit", { AbsolutePath: join(cwd, "g", "hooks", "pre-commit") }],
      ] as const) {
        expect(gate.evaluate({ name, args }), name).toEqual({ decision: "ask" });
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("git add needs configured metadata to invoke a clean filter", () => {
    const { gate, root, cwd } = makeGate({ approval: "local" });
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      const marker = join(cwd, "filter-ran");
      const filterScript = join(cwd, "filter.mjs");
      writeFileSync(filterScript, [
        'import { readFileSync, writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(marker)}, "ran\\n");`,
        "process.stdout.write(readFileSync(0));",
      ].join("\n"));
      writeFileSync(join(cwd, ".gitattributes"), "*.txt filter=x\n");
      writeFileSync(join(cwd, "input.txt"), "payload\n");
      execFileSync("git", ["config", "filter.x.clean", `${process.execPath} ${filterScript}`], { cwd });
      execFileSync("git", ["add", "input.txt"], { cwd });
      expect(existsSync(marker)).toBe(true);

      execFileSync("git", ["config", "--unset-all", "filter.x.clean"], { cwd });
      rmSync(marker);
      rmSync(join(cwd, ".git", "index"));
      execFileSync("git", ["add", "input.txt"], { cwd });
      expect(existsSync(marker)).toBe(false);
      expect(gate.evaluate({
        name: "write_to_file",
        args: { TargetFile: join(cwd, ".git", "config") },
      })).toEqual({ decision: "ask" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("local approval protects a worktree .git file", () => {
    const { gate, root, cwd } = makeGate({ approval: "local" });
    try {
      writeFileSync(join(cwd, ".git"), "gitdir: ../metadata\n");
      expect(gate.evaluate({
        name: "replace_file_content",
        args: { TargetFile: join(cwd, ".git") },
      })).toEqual({ decision: "ask" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["on-request", "never"] as const)(
    "%s preserves the existing in-workspace Git metadata write behavior",
    (approval) => {
      const { gate, root, cwd } = makeGate({ approval });
      try {
        mkdirSync(join(cwd, ".git"));
        expect(gate.evaluate({
          name: "write_to_file",
          args: { TargetFile: join(cwd, ".git", "config") },
        })).toEqual({ decision: "allow" });
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );

  it.each([
    ["on-request", "ask"],
    ["never", "allow"],
  ] as const)("%s preserves commit and merge behavior", (approval, decision) => {
    const { gate, root, cwd } = makeGate({ sandbox: "danger-full-access", approval });
    try {
      for (const command of ["git commit -m x", "git merge feature"]) {
        expect(gate.evaluate({
          name: "run_command",
          args: { CommandLine: command },
        }).decision, command).toBe(decision);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("local approval rejects read paths that escape through a symlink", () => {
    const { gate, root, cwd } = makeGate({ sandbox: "danger-full-access", approval: "local" });
    try {
      const outside = join(root, "outside-read");
      mkdirSync(outside);
      writeFileSync(join(outside, "secret"), "secret\n");
      symlinkSync(outside, join(cwd, "linked"));
      expect(gate.evaluate({
        name: "run_command",
        args: { CommandLine: "cat linked/secret" },
      })).toEqual({ decision: "ask" });
      expect(gate.evaluate({
        name: "run_command",
        args: { CommandLine: "git diff linked/secret README.md" },
      })).toEqual({ decision: "ask" });
      expect(gate.evaluate({
        name: "run_command",
        args: { CommandLine: `git commit --template ${join(cwd, "linked", "secret")}` },
      })).toEqual({ decision: "ask" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("writeはtarget schema、全path、symlink祖先をfail-closedにする", () => {
    const { gate, root, cwd, customizationDir } = makeGate();
    try {
      expect(gate.evaluate({ name: "write_to_file", args: {} })).toMatchObject({ decision: "deny" });
      expect(gate.evaluate({ name: "write_to_file", args: { TargetFile: "\0bad" } })).toMatchObject({ decision: "deny" });
      expect(gate.evaluate({ name: "write_to_file", args: {
        AbsolutePath: join(cwd, "inside.txt"), TargetFile: join(root, "outside.txt"),
      } })).toMatchObject({ decision: "deny" });
      expect(gate.evaluate({ name: "write_to_file", args: {
        TargetFile: join(root, "workspace", "..", "custom", "nested", "x.txt"),
      } })).toMatchObject({ decision: "deny" });
      const outside = join(root, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(cwd, "linked"));
      expect(gate.evaluate({ name: "write_to_file", args: {
        TargetFile: join(cwd, "linked", "not-yet-created", "x.txt"),
      } })).toMatchObject({ decision: "deny" });
      expect(gate.evaluate({ name: "view_file", args: { AbsolutePath: join(customizationDir, "secret") } })).toMatchObject({ decision: "deny" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

});
