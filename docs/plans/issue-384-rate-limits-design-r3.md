---
title: "Phase-34 B1: Rate limits from /usage, Signal Guard, and Test Isolation (Design r3 - Approved)"
description: Design revision 3 for issue #384 addressing all findings in Kohaku design review r2 (M1-M3, S1-S3, N1) and conditionally approved review r3.
status: approved
last_updated: 2026-10-02
related: [issue-384, phase-34, ADR-0057]
---

# Phase-34 B1: Rate Limits from /usage, Signal Guard, and Test Isolation (Design r3 - Approved)

- **Review reference**: `tmp/reviews/issue-384/design-r3-kohaku.md` (SHA-256: `fade9a1ce0e1f1f06f8305e227ee9de36eb5da5c53da9e466a93e336fceab8e9`)
- **Baseline**: Commit `9fe63d95759db05eb3a2862d2e1329bf3c39121a`
- **Scope**: `wrapper/antigravity/` (`subtree_termination.ts`, `customization.ts`, `host.ts`, `usage_probe.ts`, test suites, and vitest setup)

---

## 1. Review r3 Findings and Approved Resolutions

| ID | Issue & Requirement | Resolution in Final Design |
|---|---|---|
| **M1** | Proactive scratch sweep in setup risks deleting active runs; `setupTestTmpdir` must run at module load | 1. Adopt Option 1: Drop proactive scratch sweep in setup. Teardown is managed strictly via `afterAll` and `process.on("exit")`.<br>2. Execute `setupTestTmpdir()` at module top-level in `test/setup_tmpdir.ts` so loading `test.setupFiles` executes it immediately. |
| **M2** | Close the entire class against fake processes and unverified kill injections | 1. `signalOwnedChild` enforces `target instanceof ChildProcess` from `node:child_process`. Any non-`ChildProcess` target (fakes, plain objects) returns `false` with zero syscalls.<br>2. `usage_probe.ts` exposes NO kill injection seam. Unit tests verifying fake kill dispatch use `executeSignalPlanWith` or `planSignal` directly.<br>3. Negative control: pass fake process with numeric PID to `signalOwnedChild`, assert `false` returned and fake kill not called. |
| **S1** | Retention of r2 sections | Explicitly retained from r2: `tmpdir_isolation.test.ts`, passing `customizationBaseDir` to `CustomizationDir.create`, fail-closed `processIsAlive`, and Section 6.2 item 6. |
| **S2** | Clarify 5.1 and 5.2 real-process test descriptions | 1. 5.1: Host starts child via default spawn, test invokes `host.interrupt()`.<br>2. 5.2: `agyPath` points to an executable fixture script file. |
| **N1** | Regex in table | Full regex documented consistently in text and table. |

---

## 2. Process Termination Architecture: Class Closure and Safe Execution (M1, M2)

### 2.1 Pure Planning Layer (`planSignal`)
`planSignal` is a pure function with **zero side effects and zero OS syscalls**.

```ts
import type { ChildProcess } from "node:child_process";

export type SignalPlan =
  | { kind: "none" }
  | { kind: "group"; pgid: number; signal: NodeJS.Signals; fallbackTarget: ChildProcess }
  | { kind: "direct"; target: ChildProcess; signal: NodeJS.Signals };

export interface PlanSignalOptions {
  group?: boolean | undefined;
}

export function isAlive(target: ChildProcess | null | undefined): boolean {
  if (!target) return false;
  return (target.exitCode ?? null) === null && (target.signalCode ?? null) === null;
}

export function planSignal(
  target: ChildProcess | null | undefined,
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

### 2.2 Sealed Execution Layer with Class Closure (`signalOwnedChild`, `executeSignalPlanWith`) (M2)

```ts
import { ChildProcess } from "node:child_process";

export type ProcessKillFn = (pid: number, signal: NodeJS.Signals | number) => boolean | void;

/** Direct execution of a SignalPlan with an EXPLICIT, MANDATORY killFn.
 *  Enforces secondary defensive verification on pgid. */
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

/** Production entry point:
 *  M2: Closes the entire class against fakes by enforcing `target instanceof ChildProcess`.
 *  Derives plan via planSignal and executes using system process.kill. */
export function signalOwnedChild(
  target: unknown,
  signal: NodeJS.Signals,
  options: PlanSignalOptions = {},
): boolean {
  if (!(target instanceof ChildProcess)) {
    return false;
  }
  const plan = planSignal(target, signal, options);
  return executeSignalPlanWith(plan, process.kill);
}

export function signalSubtree(
  target: unknown,
  signal: NodeJS.Signals,
): boolean {
  return signalOwnedChild(target, signal, { group: true });
}
```

### 2.3 Ephemeral Plan Invariant
`SignalPlan` objects are strictly ephemeral. `terminateWithGrace` never caches a plan for deferred execution; when the escalation timer fires, it calls `signalSubtree(target, "SIGKILL")` anew, performing fresh liveness and PID evaluation at escalation time.

---

## 3. Sandboxed Test Environment: Runtime Lock & Scratch Isolation (M1, M3, S1, S2, S3)

### 3.1 Runtime Lock on `process.kill` (S1)
In `wrapper/antigravity/test/setup_tmpdir.ts`:
```ts
// S1: Lock process.kill against any mutation, assignment, or vi.spyOn
Object.defineProperty(process, "kill", {
  writable: false,
  configurable: false,
});
```

### 3.2 Scratch Directory Hygiene and Setup Execution (M1, S2, S3)
In `wrapper/antigravity/test/setup_tmpdir.ts` (configured via `test.setupFiles` in `vitest.config.ts`):

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";

// S3: Measured trace: Node v24.3.0 evaluates os.tmpdir() dynamically from process.env.TMPDIR
let initialTmp: string | undefined;

export function setupTestTmpdir(): string {
  if (!initialTmp) {
    const envTmp = process.env.TMPDIR;
    initialTmp = envTmp && !envTmp.includes("yuta384-vitest-scratch-") ? envTmp : "/tmp";
  }

  // S2: Prefix clearly marks owner (yuta), issue (384), and is disjoint from kaoiro-agy-
  const scratchRoot = mkdtempSync(join(initialTmp, "yuta384-vitest-scratch-"));
  process.env.TMPDIR = scratchRoot;

  const cleanup = () => {
    try {
      rmSync(scratchRoot, { recursive: true, force: true });
    } catch {}
  };

  afterAll(cleanup);
  process.on("exit", cleanup);

  return scratchRoot;
}

// M1: Execute immediately upon loading setupFiles module in worker
setupTestTmpdir();
```

### 3.3 Retention of r2 Hardening (S1)
- **`tmpdir_isolation.test.ts`**: Dedicated pin asserting `os.tmpdir()` starts with `scratchRoot` and is not `/tmp`.
- **`customizationBaseDir`**: Added to `AntigravityHostOptions` and threaded into `CustomizationDir.create({ baseDir: options.customizationBaseDir })` and `sweepStaleCustomizationDirs({ baseDir: options.customizationBaseDir })`.
- **Fail-Closed `processIsAlive`**:
  ```ts
  function processIsAlive(pid: number, killFn: (pid: number, signal: number) => void = process.kill): boolean {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) {
      return true; // Fail closed for unverified PIDs
    }
    try {
      killFn(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  ```

---

## 4. Elimination of Global Spies Across All Test Files (M3)

Per `git grep` on commit `11ec299f`, exactly 20 spy instances across 3 files are removed:

1. `wrapper/antigravity/test/subtree_termination.test.ts` (17 instances):
   - Migrated to pass `executeSignalPlanWith(plan, fakeKillFn)` directly.
2. `wrapper/antigravity/test/usage_probe.test.ts` (2 instances):
   - Migrated to assert on pure `planSignal` or `executeSignalPlanWith(plan, fakeKillFn)`. (M2: probe has no kill injection seam).
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

### Static Contract Gate (`test/no_process_kill_mock_gate.test.ts`)
- Pattern: Scans for `/(\bprocess\.kill\s*=(?!=)|spyOn\(\s*process\s*,\s*["']kill["']|Object\.defineProperty\(\s*process\s*,\s*["']kill["'])/`.
- Excludes the gate file itself.
- Verified by negative controls.

---

## 5. Production Default Tests with Rigorous Safety Conditions (M2, M4, S2)

### 5.1 Real Subtree Termination (`subtree_termination_real_process.test.ts`)
- **Wiring (S2)**: Production `AntigravityHost` with **no injection** of `signalSubtree` or `spawn`. Host starts the fixture child via its default spawn.
- **Targeting**: Test calls `host.interrupt()`. No PIDs read from external streams are ever signaled.
- **Pre-Signal PGID Assertion**: Asserts `childPgid === childPid && childPgid !== process.getpgrp()`.
- **Guaranteed Cleanup in `finally`**: Iterates over recorded numeric PIDs and executes `process.kill(pid, "SIGKILL")`.
- **Allowed Mutation**: Changing `signalSubtree`'s `group: true` to `group: false` leaves the grandchild alive, failing the test.

### 5.2 Real Usage Probe Subprocess Termination on `host.close()` (`usage_probe_real_process.test.ts`)
- **Wiring (S2)**: Production `AntigravityHost` with `agyPath` pointed to an executable fixture script file. No `spawn` or `usageProbeSpawn` injected.
- **Targeting**: Verifies that calling `host.close()` terminates the active probe child process group.
- **Safety Checks**: Same pre-signal PGID check and `finally` direct PID cleanup as in 5.1.

### 5.3 Production Stale Customization Sweep (`customization_sweep_real_process.test.ts`)
- Under M3's isolated `TMPDIR` scratch:
- Pre-populates dead helper child PID directory and live `process.pid` directory.
- Runs `new AntigravityHost()` with **zero sweep or processIsAlive injections**.
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

### 6.2 Negative Controls and Mutation Invariants (M2, N1)
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
6. **M2 Fake Process Class Rejection (`signalOwnedChild`)**:
   - Input: plain object fake process `{ pid: 12345, kill: vi.fn() }`.
   - Assert `signalOwnedChild` returns `false` and fake `kill` is not called.
   - *Mutation*: Removing `target instanceof ChildProcess` check causes test to fail (red).
7. **Fail-Closed Sweep (`processIsAlive`)**:
   - Invalid marker PID (`<= 1`, string, NaN) or non-ESRCH error -> treated as alive (directory retained).
   - *Mutation*: Inverting non-ESRCH check causes test to fail (red).
