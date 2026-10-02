---
title: "Phase-34 B1: Rate limits from /usage, Signal Guard, and Test Isolation (Design r3)"
description: Design revision 3 for issue #384 addressing all findings in Kohaku design review r2 (M1-M3, S1-S3, N1).
status: in_review
last_updated: 2026-10-02
related: [issue-384, phase-34, ADR-0057]
---

# Phase-34 B1: Rate Limits from /usage, Signal Guard, and Test Isolation (Design r3)

- **Review reference**: `tmp/reviews/issue-384/design-r2-kohaku.md` (SHA-256: `b82baa7daea5dfab89ca4eb97f17457095820c1bf29be17fbab10fcb00e0eba8`)
- **Baseline**: Commit `11ec299f` (`docs/plans/issue-384-rate-limits-design-r2.md`)
- **Scope**: `wrapper/antigravity/` (`subtree_termination.ts`, `customization.ts`, `host.ts`, `usage_probe.ts`, test suites, and vitest setup)

---

## 1. Review r2 Findings and Resolutions

| ID | Issue & Requirement | Resolution in Design r3 |
|---|---|---|
| **M1** | Hand-crafted plan bypasses guard; optional `processKill` leaves accidental real signals open | 1. Direct plan execution is sealed in `executeSignalPlanWith(plan, killFn)` where `killFn` is **mandatory** (type-level refusal to omit).<br>2. `executeSignalPlanWith` re-verifies PGID safety invariants (`Number.isInteger(pgid) && pgid > 1 && pgid !== process.pid`).<br>3. Invariant: `SignalPlan` is ephemeral and never cached or scheduled across time. |
| **M2** | Safety constraints missing for the 2 real-process tests | 6 strict safety rules specified: (1) target only test-spawned handles, (2) verify PGID == PID != runner PGID before signaling, (3) `finally` direct PID cleanup, (4) test 1 uses real `host.interrupt()` defaults, (5) test 2 uses real `host.close()` defaults, (6) only `group: true -> false` mutation is allowed. |
| **M3** | Spy removal list omitted `subtree_termination_real_process.test.ts:242`, conflicting with gate | 1. Correct grep-derived removal list across all 3 files (20 total sites).<br>2. Replaced line 242 observation with a non-mutating recording wrapper via `AntigravityHostOptions.signalSubtree` in a separate observation test case. |
| **S1** | Static scan is mere observation; mock installation must be blocked at runtime | 1. In `setup_tmpdir.ts`, lock `process.kill` at runtime via `Object.defineProperty(process, "kill", { writable: false, configurable: false })`, causing `vi.spyOn` and assignments to throw `TypeError` at installation time.<br>2. Retain static gate with hardened regex (`/(\bprocess\.kill\s*=(?!=)|spyOn\(\s*process\s*,\s*["']kill["']|Object\.defineProperty\(\s*process\s*,\s*["']kill["'])/`), self-exclusion, and dual negative controls. |
| **S2** | Scratch naming overlap and lifecycle hygiene | 1. Renamed scratch prefix to `/tmp/yuta384-vitest-scratch-XXXXXX`, completely disjoint from sweep pattern `kaoiro-agy-`.<br>2. Idempotent setup caching `initialSystemTmpdir` to prevent nested scratch dirs.<br>3. Teardown via `afterAll` and `process.on("exit")`; orphaned scratch swept by setup on subsequent runs. |
| **S3** | "Verified" assertions must include reproducible trace | Grounded with exact measurement: `Node v24.3.0: node -e 'os.tmpdir(); process.env.TMPDIR="/tmp/zz-x"; console.log(os.tmpdir())' -> /tmp/zz-x`. |
| **N1** | Missing mutation notes for mapping negative controls 3 & 4 | Added explicit mutation specifications: threshold / suppression deletion for 3, try-catch removal for 4. |

---

## 2. Process Termination Architecture: Sealed Decision and Safe Execution (M1)

### 2.1 Pure Planning Layer (`planSignal`)
`planSignal` remains an exported, pure function with **zero side effects and zero OS syscalls**.

```ts
export type SignalPlan =
  | { kind: "none" }
  | { kind: "group"; pgid: number; signal: NodeJS.Signals; fallbackTarget: TerminableProcess }
  | { kind: "direct"; target: TerminableProcess; signal: NodeJS.Signals };

export interface PlanSignalOptions {
  group?: boolean | undefined;
}

export function isAlive(target: TerminableProcess | null | undefined): boolean {
  if (!target) return false;
  return (target.exitCode ?? null) === null && (target.signalCode ?? null) === null;
}

export function planSignal(
  target: TerminableProcess | null | undefined,
  signal: NodeJS.Signals,
  options: PlanSignalOptions = {},
): SignalPlan {
  if (!target || !isAlive(target)) {
    return { kind: "none" };
  }

  const pid = target.pid;
  // Guard invariants: must be integer > 1, and never self/caller process.pid
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 1 ||
    pid === process.pid
  ) {
    return { kind: "none" };
  }

  if (options.group) {
    return {
      kind: "group",
      pgid: pid,
      signal,
      fallbackTarget: target,
    };
  }

  return {
    kind: "direct",
    target,
    signal,
  };
}
```

### 2.2 Sealed Execution Layer (`executeSignalPlanWith`)
To close M1:
1. `executeSignalPlan` with optional `processKill` is eliminated.
2. For testing plan execution directly with custom plans or fakes, `executeSignalPlanWith` requires a non-optional `killFn`. Omission fails at compile time.
3. Secondary defensive verification is enforced inside `executeSignalPlanWith` on `plan.pgid`.
4. The production entry points `signalOwnedChild` and `signalSubtree` are the ONLY functions that bind to system `process.kill`.

```ts
export type ProcessKillFn = (pid: number, signal: NodeJS.Signals | number) => boolean | void;

/** Direct execution of a SignalPlan with an EXPLICIT, MANDATORY killFn.
 *  Enforces secondary defensive verification on pgid to protect against hand-crafted invalid plans. */
export function executeSignalPlanWith(
  plan: SignalPlan,
  killFn: ProcessKillFn,
): boolean {
  if (plan.kind === "none") {
    return false;
  }

  if (plan.kind === "group") {
    // Secondary defensive barrier: even hand-crafted plans cannot bypass PGID invariants
    if (
      typeof plan.pgid !== "number" ||
      !Number.isInteger(plan.pgid) ||
      plan.pgid <= 1 ||
      plan.pgid === process.pid
    ) {
      return false;
    }
    try {
      killFn(-plan.pgid, plan.signal);
      return true;
    } catch {
      // Group kill failed (e.g. ESRCH or child not group leader); fall back to direct target.kill
    }
    try {
      return plan.fallbackTarget.kill(plan.signal);
    } catch {
      return false;
    }
  }

  try {
    return plan.target.kill(plan.signal);
  } catch {
    return false;
  }
}

/** Production entry point: derives plan via planSignal and executes using system process.kill. */
export function signalOwnedChild(
  target: TerminableProcess | null | undefined,
  signal: NodeJS.Signals,
  options: PlanSignalOptions = {},
): boolean {
  const plan = planSignal(target, signal, options);
  return executeSignalPlanWith(plan, process.kill);
}

export function signalSubtree(
  target: TerminableProcess | null | undefined,
  signal: NodeJS.Signals,
): boolean {
  return signalOwnedChild(target, signal, { group: true });
}
```

### 2.3 Ephemeral Plan Invariant (M1.3)
`SignalPlan` objects are strictly ephemeral:
- A `SignalPlan` is generated and executed synchronously within the same tick.
- It is never stored in variables, properties, or timer callbacks for deferred execution.
- In `terminateWithGrace`, the delayed SIGKILL escalation invokes `signalSubtree(target, "SIGKILL")` anew when the timer fires, re-evaluating target liveness and process group eligibility at escalation time.

---

## 3. Sandboxed Test Environment: Runtime Lock & Scratch Isolation (M3, S1, S2, S3)

### 3.1 Runtime Lock on `process.kill` (S1)
To ensure no test can ever install a global mock on `process.kill`:
In `wrapper/antigravity/test/setup_tmpdir.ts`:
```ts
// S1: Lock process.kill against any mutation, assignment, or vi.spyOn
Object.defineProperty(process, "kill", {
  writable: false,
  configurable: false,
});
```
*Effect*: Any call to `vi.spyOn(process, "kill")` or assignment `process.kill = ...` immediately throws a `TypeError: Cannot redefine property: kill` at installation time in strict mode.

### 3.2 Scratch Directory Hygiene and Naming (S2, S3)
In `wrapper/antigravity/test/setup_tmpdir.ts` (configured via `test.setupFiles` in `vitest.config.ts`):

```ts
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// S3: Measured trace: Node v24.3.0 evaluates os.tmpdir() dynamically from process.env.TMPDIR
let initialTmp: string | undefined;

export function setupTestTmpdir(): string {
  if (!initialTmp) {
    const envTmp = process.env.TMPDIR;
    initialTmp = envTmp && !envTmp.includes("yuta384-vitest-scratch-") ? envTmp : "/tmp";
  }

  // Sweep any orphaned scratch directories from killed previous runs (> 1 hour old)
  try {
    for (const entry of readdirSync(initialTmp, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("yuta384-vitest-scratch-")) {
        // prune abandoned test scratch
        rmSync(join(initialTmp, entry.name), { recursive: true, force: true });
      }
    }
  } catch {}

  // S2: Prefix clearly marks owner (yuta), issue (384), and is disjoint from kaoiro-agy-
  const scratchRoot = mkdtempSync(join(initialTmp, "yuta384-vitest-scratch-"));
  process.env.TMPDIR = scratchRoot;

  afterAll(() => {
    try {
      rmSync(scratchRoot, { recursive: true, force: true });
    } catch {}
  });

  return scratchRoot;
}
```

### 3.3 Static Contract Gate (`test/no_process_kill_mock_gate.test.ts`) (M5, S1)
A complementary static analysis test scans all test files:
- Scope: All `.ts` and `.js` files under `wrapper/antigravity/test/`.
- Excludes the gate file itself.
- Pattern: Checks for `spyOn(process, "kill")`, assignments `process.kill =`, `process["kill"] =`, or `defineProperty(process, "kill")`.
- Negative Controls:
  1. Temporary dummy spy in existing file fails the gate (red).
  2. Temporary dummy spy in new file fails the gate (red).
  3. Clean test files pass (green).

---

## 4. Elimination of Global Spies Across All Test Files (M3)

Per `git grep` on commit `11ec299f`, exactly 20 spy instances across 3 files are removed:

1. `wrapper/antigravity/test/subtree_termination.test.ts` (17 instances):
   - All tests migrated to pass `executeSignalPlanWith(plan, fakeKillFn)` directly, asserting on `fakeKillFn` calls. Zero calls to `vi.spyOn(process, "kill")`.
2. `wrapper/antigravity/test/usage_probe.test.ts` (2 instances):
   - Migrated to pass local `killFn` to `RunAgyUsageProbeOptions.processKill` or assert on pure `planSignal`.
3. `wrapper/antigravity/test/subtree_termination_real_process.test.ts` (1 instance at line 242):
   - Migrated to an observation test case injecting a pass-through wrapper into `AntigravityHostOptions.signalSubtree`:
     ```ts
     const recordedSignals: NodeJS.Signals[] = [];
     const host = new AntigravityHost(cfg, {
       // ...
       signalSubtree: (target, signal) => {
         recordedSignals.push(signal);
         return signalSubtree(target, signal);
       },
     });
     ```
     Verifies that no SIGKILL is recorded without mutating or spying on `process.kill`.

---

## 5. Production Default Tests with Rigorous Safety Conditions (M2, M4)

The two real-process tests and one sweep test are specified with strict safety invariants:

### 5.1 Real Subtree Termination (`subtree_termination_real_process.test.ts`)
- **Wiring**: Production `AntigravityHost` with **no injection** of `signalSubtree` or `spawn`.
- **Targeting (M2.1)**: Only the test's own spawned `ChildProcess` handle is passed to `host.interrupt()`. No PIDs read from external streams are ever signaled.
- **Pre-Signal PGID Assertion (M2.2)**:
  Before sending any signal, the test reads `/proc/<pid>/stat` (field 5) or `ps -o pgid= -p <pid>` and asserts:
  `childPgid === childPid && childPgid !== process.getpgrp()`.
  If assertion fails, test immediately aborts without signaling.
- **Guaranteed Cleanup in `finally` (M2.3)**:
  Recorded child and grandchild PIDs are collected. The `finally` block iterates over recorded numeric PIDs and executes `process.kill(pid, "SIGKILL")` directly in try-catch. No wildcard pattern killing (`pkill`) is permitted.
- **Allowed Mutation (M2.6)**:
  Changing `signalSubtree`'s `group: true` to `group: false` leaves the grandchild alive, failing the test.

### 5.2 Real Usage Probe Subprocess Termination on `host.close()` (`usage_probe_real_process.test.ts`)
- **Wiring**: Production `AntigravityHost` configured with `agyPath` set to a harmless local node script (`node -e 'setInterval(()=>{},1000)'`). No `spawn` or `usageProbeSpawn` injected.
- **Targeting (M2.1, M2.5)**: Verifies that calling `host.close()` terminates the active probe child process group.
- **Safety Checks**: Same pre-signal PGID check and `finally` direct PID cleanup as in 5.1.

### 5.3 Production Stale Customization Sweep (`customization_sweep_real_process.test.ts`)
- Under M3's isolated `TMPDIR` scratch:
- Spawns a real helper child process and waits for its exit (`code === 0`), obtaining a guaranteed dead PID. Writes `.kaoiro-owner.json` marker.
- Writes a second directory with `process.pid` (guaranteed live PID).
- Instantiates `new AntigravityHost()` with **zero sweep or processIsAlive injections**.
- Asserts dead PID directory is unlinked and live PID directory remains intact.

---

## 6. /usage Mapping, Negative Controls & Mutation Assertions (N1)

### 6.1 Mapping Rules
- `gemini-*` models -> `gemini-5h` (`five_hour`), `gemini-weekly` (`seven_day`).
- `claude-*`, `gpt-*` models -> `3p-5h` (`five_hour`), `3p-weekly` (`seven_day`).
- Unknown models -> returns `null`, `rate_limits` omitted from snapshot.
- `utilization`: `1 - remaining_fraction`.
- `resets_at`: Unix epoch seconds, emitted **only** when `remaining_fraction < 1.0`.
- Terminal 429 locks `seven_day: blocked` until next successful turn result.

### 6.2 Negative Controls and Mutation Invariants (N1)
1. **Unmapped Model**: Unmapped model name -> `rate_limits` is `undefined`.
   - *Mutation*: Adding a fallback mapping causes test to fail (red).
2. **Unused Bucket Resets Omission**: `remaining_fraction: 1.0` -> `resets_at` is `undefined`.
   - *Mutation*: Removing `remaining < 1.0` check causes test to fail (red).
3. **Probe Consecutive Failure Suppression**:
   - 3 consecutive failures suppress subsequent probes until next successful turn.
   - *Mutation*: Changing failure threshold from 3 to 4, or deleting suppression check, causes test to fail (red).
4. **Malformed Payload Resilience**:
   - Corrupted JSON or non-SUCCESS status returns `null` without throwing.
   - *Mutation*: Removing JSON parse try-catch causes test to fail (red).
5. **Guard Boundary Invariants (`planSignal`)**:
   - Inputs: `undefined`, `null`, `0`, `1`, `-1`, `process.pid`, `NaN`, `1.5`, `exitCode: 0`.
   - Assert all return `{ kind: "none" }`.
   - *Mutation*: Removing `pid <= 1` or `pid === process.pid` causes test to fail (red).
6. **Fail-Closed Sweep (`processIsAlive`)**:
   - Invalid marker PID (`<= 1`, string, NaN) or non-ESRCH error -> treated as alive (directory retained).
   - *Mutation*: Inverting non-ESRCH check causes test to fail (red).
