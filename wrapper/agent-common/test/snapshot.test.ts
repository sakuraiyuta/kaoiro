// computeResumeDrift semantics (ADR-0014 F1 追補, phase-15 D8):
// - fields absent from BOTH sides → not drift
// - fields with equal values → not drift
// - fields that differ (incl. undefined vs value) → drift
// - order follows SNAPSHOT_FIELDS (deterministic)

import { describe, expect, it } from "vitest";
import {
  computeResumeDrift,
  effectiveStatusEnvelopeFields,
  effectiveStatusWhoamiFields,
} from "../src/snapshot.js";
import type { ResolvedSnapshotExt } from "../src/types.js";

describe("computeResumeDrift", () => {
  it("同一 snapshot は drift なし (空配列)", () => {
    const snap: ResolvedSnapshotExt = {
      model: "claude-opus-4-7",
      model_source: "config",
      permission_mode: "default",
      sandbox: "workspace-write",
    };
    expect(computeResumeDrift(snap, snap)).toEqual([]);
  });

  it("model が変わっていれば drift として prev/now を並記する", () => {
    const prev: ResolvedSnapshotExt = { model: "claude-opus-4-7" };
    const now: ResolvedSnapshotExt = { model: "claude-sonnet-4-6" };
    expect(computeResumeDrift(prev, now)).toEqual([
      { field: "model", prev: "claude-opus-4-7", now: "claude-sonnet-4-6" },
    ]);
  });

  it("undefined vs value は drift (intentional 切替は snapshot 側にも反映されている前提)", () => {
    const prev: ResolvedSnapshotExt = {};
    const now: ResolvedSnapshotExt = { permission_mode: "plan" };
    expect(computeResumeDrift(prev, now)).toEqual([
      { field: "permission_mode", prev: undefined, now: "plan" },
    ]);
  });

  it("approval が変わっていれば drift として prev/now を並記する (ADR-0057 F4c, antigravity)", () => {
    const prev: ResolvedSnapshotExt = { approval: "on-request" };
    const now: ResolvedSnapshotExt = { approval: "never" };
    expect(computeResumeDrift(prev, now)).toEqual([
      { field: "approval", prev: "on-request", now: "never" },
    ]);
  });

  it("両側 undefined は drift ではない", () => {
    const prev: ResolvedSnapshotExt = { model: "x" };
    const now: ResolvedSnapshotExt = { model: "x" };
    // network_access は両側で undefined
    const drift = computeResumeDrift(prev, now);
    expect(drift.find((d) => d.field === "network_access")).toBeUndefined();
    expect(drift).toEqual([]);
  });

  it("複数 field が変わっていれば SNAPSHOT_FIELDS 順で並ぶ (決定論)", () => {
    const prev: ResolvedSnapshotExt = {
      model: "a",
      permission_mode: "default",
      sandbox: "workspace-write",
    };
    const now: ResolvedSnapshotExt = {
      model: "b",
      permission_mode: "plan",
      sandbox: "read-only",
    };
    // 順序: model, model_source (両 undefined = skip), effort (skip),
    // effort_source (skip), permission_mode, sandbox, network_access (skip),
    // approval (skip)
    expect(computeResumeDrift(prev, now)).toEqual([
      { field: "model", prev: "a", now: "b" },
      { field: "permission_mode", prev: "default", now: "plan" },
      { field: "sandbox", prev: "workspace-write", now: "read-only" },
    ]);
  });
});

describe("EffectiveStatusSnapshot projection (#113)", () => {
  const snapshot = {
    engine: "codex" as const,
    resolved: {
      model: "gpt-5.6-sol",
      model_source: "default" as const,
      effort: "xhigh",
      effort_source: "config" as const,
      sandbox: "workspace-write" as const,
      network_access: true,
    },
    permission: {
      sandbox: "workspace-write" as const,
      approval: "never" as const,
    },
  };

  it("state_change.ext と whoami を同じ resolved snapshot から投影する", () => {
    expect(effectiveStatusEnvelopeFields(snapshot)).toEqual({
      engine: "codex",
      model: "gpt-5.6-sol",
      model_source: "default",
      effort: "xhigh",
      effort_source: "config",
      permission: { sandbox: "workspace-write", approval: "never" },
      effective: snapshot.resolved,
    });
    expect(effectiveStatusWhoamiFields(snapshot)).toEqual({
      engine: "codex",
      model: "gpt-5.6-sol",
      model_source: "default",
      effort: "xhigh",
      effort_source: "config",
      permission: { sandbox: "workspace-write", approval: "never" },
      network_access: true,
    });
  });

  it("未知 field は推測せず omit する", () => {
    expect(
      effectiveStatusWhoamiFields({
        engine: "claude-code",
        resolved: {},
      }),
    ).toEqual({ engine: "claude-code" });
  });
});
