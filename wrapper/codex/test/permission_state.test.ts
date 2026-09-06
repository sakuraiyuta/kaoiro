import { describe, expect, it } from "vitest";
import type {
  PermissionControlExt,
  PermissionObservation,
  PermissionSelection,
  PermissionSubmission,
} from "@kaoiro/protocol";
import {
  applyPermissionSyncState,
  beginPermissionExecution,
  createPermissionState,
  permissionObservationApplied,
  permissionObservationFailed,
  projectPermissionState,
  requestPermission,
  setPermissionSyncSupport,
} from "../src/permission_state.js";

const baseline: PermissionSelection = {
  revision: 0,
  requested: { sandbox: "read-only", network_access: false },
};
const widened: PermissionSelection = {
  revision: 2,
  requested: { sandbox: "workspace-write", network_access: true },
};

function submission(selection: PermissionSelection, id = "execution"): PermissionSubmission {
  return { ...selection, execution_id: id };
}

function observation(
  selection: PermissionSelection,
  id = "turn",
  networkAccess = true,
): PermissionObservation {
  return {
    ...submission(selection, `execution-${id}`),
    session_id: "session",
    turn_id: id,
    permission: {
      sandbox: selection.requested.sandbox,
      approval: "never",
      enforcement: "os",
    },
    network_access: networkAccess,
  };
}

function rejected(
  control: PermissionSelection,
  rolledBackTo = baseline.requested,
): Extract<PermissionControlExt, { status: "failed" }> {
  return {
    ...control,
    constraints: { approval: "never", enforcement: "os" },
    status: "failed",
    reason: "rejected_before_application",
    rolled_back_to: rolledBackTo,
  };
}

describe("Codex permission-state projector", () => {
  it("accepts a lower next only from the server's explicit pre-application rollback", () => {
    let state = createPermissionState(baseline, true);
    state = requestPermission(state, widened);
    state = applyPermissionSyncState(state, {
      version: "0",
      control: rejected(widened),
      next: baseline,
    });

    expect(state.next).toEqual(baseline);
    expect(projectPermissionState(state).control).toMatchObject({
      revision: 2,
      status: "failed",
    });
  });

  it("does not let an older live selection lower the latest request", () => {
    let state = createPermissionState(baseline, true);
    state = applyPermissionSyncState(state, {
      version: "0",
      control: rejected(widened),
      next: baseline,
    });
    state = requestPermission(state, {
      revision: 1,
      requested: { sandbox: "workspace-write", network_access: false },
    });

    expect(projectPermissionState(state).control).toMatchObject({
      revision: 2,
      status: "failed",
    });
    expect(state.next).toEqual(baseline);
  });

  it("does not regress an observed revision to a delayed pending sync", () => {
    const selected: PermissionSelection = {
      revision: 1,
      requested: { sandbox: "workspace-write", network_access: true },
    };
    let state = requestPermission(createPermissionState(baseline, true), selected);
    state = beginPermissionExecution(state, submission(selected));
    const observed = observation(selected);
    state = permissionObservationApplied(state, observed).state;
    state = applyPermissionSyncState(state, {
      version: "0",
      control: {
        ...selected,
        constraints: { approval: "never", enforcement: "os" },
        status: "applied",
        submitted: submission(selected),
        effective: observed,
      },
      next: selected,
    });
    state = applyPermissionSyncState(state, {
      version: "0",
      control: {
        ...selected,
        constraints: { approval: "never", enforcement: "os" },
        status: "pending",
      },
      next: selected,
    });

    expect(projectPermissionState(state).control).toMatchObject({
      revision: 1,
      status: "applied",
      effective: { turn_id: "turn" },
    });
    expect(state.latest?.status).toBe("applied");
  });

  it("keeps restored applied evidence historical until this process observes an exec", () => {
    const selected: PermissionSelection = {
      revision: 1,
      requested: { sandbox: "workspace-write", network_access: true },
    };
    const prior = observation(selected, "prior");
    let state = createPermissionState(baseline, true);
    state = applyPermissionSyncState(state, {
      version: "0",
      control: {
        ...selected,
        constraints: { approval: "never", enforcement: "os" },
        status: "applied",
        submitted: submission(selected, "prior-execution"),
        effective: prior,
      },
      next: selected,
    });

    const projected = projectPermissionState(state);
    expect(projected.observation).toBeNull();
    expect(projected.control).toMatchObject({
      revision: 1,
      status: "pending",
      last_effective: { turn_id: "prior" },
    });
    expect(projected.control).not.toHaveProperty("effective");
  });

  it("does not reintroduce launch values after unknown state downgrades to legacy", () => {
    let state = createPermissionState(baseline, true);
    const started = beginPermissionExecution(state, submission(baseline));
    state = permissionObservationFailed(
      started,
      submission(baseline),
      "observation_unavailable",
      null,
    );
    state = setPermissionSyncSupport(state, false);

    const projected = projectPermissionState(state);
    expect(projected.observation).toBeNull();
    expect(projected.usesLegacyFallback).toBe(false);
  });

  it("keeps a blocked selection when a rejected successor rolls back to it", () => {
    const blockedSelection: PermissionSelection = {
      revision: 1,
      requested: { sandbox: "workspace-write", network_access: true },
    };
    const rejectedSuccessor: PermissionSelection = {
      revision: 2,
      requested: { sandbox: "read-only", network_access: false },
    };
    let state = requestPermission(
      createPermissionState(baseline, true),
      blockedSelection,
    );
    state = permissionObservationFailed(
      beginPermissionExecution(state, submission(blockedSelection)),
      submission(blockedSelection),
      "observation_unavailable",
      null,
    );
    state = applyPermissionSyncState(state, {
      version: "0",
      control: rejected(rejectedSuccessor, blockedSelection.requested),
      next: blockedSelection,
    });

    expect(state.next).toEqual(blockedSelection);
    expect(state.blocked).toEqual({
      revision: 1,
      reason: "observation_unavailable",
    });
  });

  it("restores audit dedupe from a failed successor's historical effective evidence", () => {
    const selected: PermissionSelection = {
      revision: 1,
      requested: { sandbox: "workspace-write", network_access: true },
    };
    const prior = observation(selected, "prior");
    let state = createPermissionState(baseline, true);
    state = applyPermissionSyncState(state, {
      version: "0",
      control: {
        ...widened,
        constraints: { approval: "never", enforcement: "os" },
        status: "failed",
        reason: "rejected_before_application",
        rolled_back_to: selected.requested,
        last_effective: prior,
      },
      next: selected,
    });
    state = beginPermissionExecution(state, submission(selected, "reassert"));
    const applied = permissionObservationApplied(state, observation(selected, "again"));

    expect(applied.emitAudit).toBe(false);
  });

  it("filters intentional resume drift per permission axis", () => {
    const selected: PermissionSelection = {
      revision: 1,
      requested: { sandbox: "workspace-write", network_access: true },
    };
    let state = requestPermission(createPermissionState(baseline, true), selected);
    state = beginPermissionExecution(state, submission(selected));
    state = permissionObservationApplied(
      state,
      observation(selected, "mismatch", false),
    ).state;

    expect(projectPermissionState(state).intentional).toEqual({
      sandbox: true,
      networkAccess: false,
    });
  });
});
