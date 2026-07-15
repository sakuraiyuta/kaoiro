// Unit tests for the resume snapshot validate + apply helpers
// (ADR-0014 F1 追補, resume-privilege-restoration).

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { EngineKind } from "@kaoiro/protocol";
import type { ParsedSpawn } from "../src/supervisor.js";
import {
  applyResumeSnapshot,
  validateResolvedSnapshot,
} from "../src/resume_snapshot.js";

const persona = { id: "p", name: "p", sprite_set: "s" } as const;

function makeParsed(engine: EngineKind = "codex"): ParsedSpawn {
  return { persona, cwd: "/w", engine };
}

describe("validateResolvedSnapshot (藤 D2 read-side sanitize)", () => {
  test("完全に有効な 7 field は全て保持される", () => {
    const result = validateResolvedSnapshot({
      model: "gpt-5",
      model_source: "config",
      effort: "high",
      effort_source: "launch",
      permission_mode: "bypassPermissions",
      sandbox: "danger-full-access",
      network_access: true,
    });
    expect(result).toEqual({
      model: "gpt-5",
      model_source: "config",
      effort: "high",
      effort_source: "launch",
      permission_mode: "bypassPermissions",
      sandbox: "danger-full-access",
      network_access: true,
    });
  });

  test("非 object は null (defensive drop)", () => {
    expect(validateResolvedSnapshot(undefined)).toBeNull();
    expect(validateResolvedSnapshot(null)).toBeNull();
    expect(validateResolvedSnapshot("string")).toBeNull();
    expect(validateResolvedSnapshot(42)).toBeNull();
    expect(validateResolvedSnapshot([1, 2])).toBeNull();
  });

  test("malformed sandbox は drop、他 field は保持", () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = validateResolvedSnapshot({
      sandbox: "hacked",
      permission_mode: "plan",
    });
    expect(result).toEqual({ permission_mode: "plan" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dropped invalid field"),
    );
    warn.mockRestore();
  });

  test("malformed permission_mode は drop", () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = validateResolvedSnapshot({ permission_mode: "GodMode" });
    expect(result).toEqual({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("network_access 非 boolean は drop", () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = validateResolvedSnapshot({ network_access: 1 });
    expect(result).toEqual({});
    warn.mockRestore();
  });

  test("network_access=false explicit は保持 (truthy 判定禁止 pin)", () => {
    const result = validateResolvedSnapshot({
      network_access: false,
      sandbox: "workspace-write",
    });
    expect(result).toEqual({
      network_access: false,
      sandbox: "workspace-write",
    });
  });

  test("unknown key は drop、known は保持", () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = validateResolvedSnapshot({
      model: "gpt-5",
      foo: "bar",
      __proto__: "danger",
    });
    expect(result).toEqual({ model: "gpt-5" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("empty string model / effort は drop", () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(validateResolvedSnapshot({ model: "" })).toEqual({});
    expect(validateResolvedSnapshot({ effort: "" })).toEqual({});
    warn.mockRestore();
  });

  test("malformed model_source は drop", () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(validateResolvedSnapshot({ model_source: "guess" })).toEqual({});
    warn.mockRestore();
  });
});

describe("applyResumeSnapshot (藤 D1/D2 engine-aware apply)", () => {
  test("snapshot が null なら no-op (fresh spawn / crash-restart / rollback)", () => {
    const parsed = { ...makeParsed(), sandbox: "read-only" as const };
    const next = applyResumeSnapshot(parsed, null, "codex");
    expect(next).toEqual(parsed);
    // Reference-equality is not required; identity is not part of the contract.
  });

  test("snapshot が undefined なら no-op", () => {
    const parsed = makeParsed();
    const next = applyResumeSnapshot(parsed, undefined, "codex");
    expect(next).toEqual(parsed);
  });

  describe("engine=codex", () => {
    test("snapshot.sandbox / network_access を parsed に上書き", () => {
      const parsed: ParsedSpawn = {
        ...makeParsed("codex"),
        sandbox: "read-only",
        networkAccess: false,
      };
      const next = applyResumeSnapshot(
        parsed,
        {
          sandbox: "danger-full-access",
          network_access: true,
          permission_mode: "plan",
        },
        "codex",
      );
      expect(next.sandbox).toBe("danger-full-access");
      expect(next.networkAccess).toBe(true);
      // Claude 用 permission_mode は Codex では apply しない。
      expect(next.permissionMode).toBeUndefined();
    });

    test("snapshot.sandbox absent → safe default workspace-write に降格", () => {
      const parsed: ParsedSpawn = {
        ...makeParsed("codex"),
        sandbox: "danger-full-access",
      };
      const next = applyResumeSnapshot(
        parsed,
        { network_access: true },
        "codex",
      );
      expect(next.sandbox).toBe("workspace-write");
      // 旧 danger 値保持禁止 (D2)。
    });

    test("snapshot.network_access absent → safe default false に降格", () => {
      const parsed: ParsedSpawn = {
        ...makeParsed("codex"),
        networkAccess: true,
      };
      const next = applyResumeSnapshot(
        parsed,
        { sandbox: "workspace-write" },
        "codex",
      );
      expect(next.networkAccess).toBe(false);
    });

    test("snapshot.network_access=false explicit は保持 (truthy-drop 禁止 pin)", () => {
      const parsed: ParsedSpawn = {
        ...makeParsed("codex"),
        networkAccess: true,
      };
      const next = applyResumeSnapshot(
        parsed,
        { sandbox: "workspace-write", network_access: false },
        "codex",
      );
      expect(next.networkAccess).toBe(false);
    });

    test("空 snapshot {} → 両 field とも safe default に降格", () => {
      const parsed: ParsedSpawn = {
        ...makeParsed("codex"),
        sandbox: "danger-full-access",
        networkAccess: true,
      };
      const next = applyResumeSnapshot(parsed, {}, "codex");
      expect(next.sandbox).toBe("workspace-write");
      expect(next.networkAccess).toBe(false);
    });
  });

  describe("engine=claude-code", () => {
    test("snapshot.permission_mode を parsed に上書き", () => {
      const parsed: ParsedSpawn = {
        ...makeParsed("claude-code"),
        permissionMode: "plan",
      };
      const next = applyResumeSnapshot(
        parsed,
        {
          permission_mode: "bypassPermissions",
          // Claude で sandbox は permission_mode 写像。apply 対象外だが
          // sanitized snapshot には保持されている (D4)。
          sandbox: "danger-full-access",
          network_access: true,
        },
        "claude-code",
      );
      expect(next.permissionMode).toBe("bypassPermissions");
      // sandbox / networkAccess は Claude では apply しない。
      expect(next.sandbox).toBeUndefined();
      expect(next.networkAccess).toBeUndefined();
    });

    test("snapshot.permission_mode absent → safe default に降格", () => {
      const parsed: ParsedSpawn = {
        ...makeParsed("claude-code"),
        permissionMode: "bypassPermissions",
      };
      const next = applyResumeSnapshot(
        parsed,
        { sandbox: "workspace-write" },
        "claude-code",
      );
      expect(next.permissionMode).toBe("default");
    });
  });

  test("model / effort / *_source は apply しない (P1 scope)", () => {
    const parsed = makeParsed("codex");
    const next = applyResumeSnapshot(
      parsed,
      {
        model: "gpt-5",
        model_source: "config",
        effort: "high",
        effort_source: "launch",
      },
      "codex",
    );
    // ParsedSpawn の model / effort は undefined のまま (apply 対象外)。
    expect(next.model).toBeUndefined();
    expect(next.effort).toBeUndefined();
  });
});
