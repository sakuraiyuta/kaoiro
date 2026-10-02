---
title: "Phase-34 B1: Rate limits from /usage, Signal Guard, and Test Isolation (Design r2)"
description: Design revision 2 for issue #384 addressing all findings in Kohaku design review r1 (M1-M5, S1-S4, N1).
status: in_review
last_updated: 2026-10-02
related: [issue-384, phase-34, ADR-0057]
---

# Phase-34 B1: Rate Limits from /usage, Signal Guard, and Test Isolation (Design r2)

- **Review reference**: `tmp/reviews/issue-384/design-r1-kohaku.md` (SHA-256: `37156d96c15163613b275865b225617771e37dd4238d12213fd4083557aae74b`)
- **Baseline**: Commit `43aed2d5`
- **Scope**: `wrapper/antigravity/` (`subtree_termination.ts`, `customization.ts`, `host.ts`, `usage_probe.ts`, test suites, and vitest setup)

---

## 1. Executive Summary & Review r1 Responses

Design revision 2 completely resolves all 5 must-fix items, 4 should suggestions, and 1 nit from review r1:

| ID | Issue & Requirement | Resolution in Design r2 |
|---|---|---|
| **M1** | `pid === 1` passes guard, turning into `kill(-1)` (all processes) | Group kill strictly requires `pid > 1`. Reject `pid === process.pid` (self/group signaling). `1` and `process.pid` added to negative controls. |
| **M2** | Guard mutation can reach real OS syscalls | Split into pure decision `planSignal()` (returns plan without syscalls) and thin executor `executeSignalPlan()`. Guard mutation and negative controls run strictly against `planSignal`. |
| **M3** | Test `/tmp` isolation depends on harness memory | Sandboxed test `TMPDIR` configured in `wrapper/antigravity/vitest.config.ts`. All `tmpdir()` calls across all 20+ test files fall into run scratch automatically. Verified by a dedicated test. |
| **M4** | No test runs production default configuration | Dedicated production-default tests for: (1) real process group signal propagation, (2) live probe subprocess tree termination on `host.close()`, and (3) default stale customization sweep. |
| **M5** | Global `process.kill` spy removal incomplete; no prevention gate | Complete removal of all `process.kill` spies in `wrapper/antigravity/test/` (including `usage_probe.test.ts`). Static gate test prevents future introductions. |
| **S1** | `processIsAlive` ESRCH check does not prevent mock accident | Acknowledged: M3/M5 are the primary incident defenses. `processIsAlive` non-ESRCH fail-closed check is a defense-in-depth against unexpected errors. Unverified marker PIDs treated as alive (fail-closed). Negative control 7 injects local function. |
| **S2** | `sweepCustomizationDirs: false` switch is redundant with M3 | Adopted: Dropped `sweepCustomizationDirs: boolean`. Production always sweeps; tests are isolated via M3 `TMPDIR`. |
| **S3** | `customizationBaseDir` must also apply to directory creation | Adopted: `baseDir?: string` passed to `CustomizationOptions` and `CustomizationDir.create`, unified with sweep. |
| **S4** | Document behavioral change on unverified PID | Adopted: Documented that `target.pid === undefined` now returns `false` (no `target.kill()` fallback), inverting pin `subtree_termination.test.ts:65`. |
| **N1** | Mapping negative controls are behavioral unit tests | Adopted: Classified as unit tests against fixtures with single-mutation verification. |

---

## 2. Process Termination Architecture: Pure Planning & Execution

To prevent guard mutations from ever reaching real syscalls (M2) and close POSIX `kill(-1)` loopholes (M1), signal handling is divided into two distinct layers: a pure planning layer and a thin execution layer.

### 2.1 Pure Planning Layer (`planSignal`)

`planSignal` is a pure function with **zero syscalls and zero side effects**.

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
  // M1: Reject unverified, non-integer, non-positive, init (pid=1), or self (pid=process.pid)
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

#### Invariants Enforced by `planSignal`:
1. `!target || !isAlive(target)` -> `{ kind: "none" }`.
2. `pid === undefined` (spawn failure, unspawned mock, or delayed spawn) -> `{ kind: "none" }`. **S4**: This changes the legacy behavior in `subtree_termination.ts` which previously called `target.kill()`. The existing pin `subtree_termination.test.ts:65` is inverted to assert `{ kind: "none" }` and zero kill calls.
3. `pid <= 1` (including `pid === 0`, negative numbers, and `pid === 1`) -> `{ kind: "none" }`. Eliminates `kill(0)` and `kill(-1)` completely.
4. `pid === process.pid` -> `{ kind: "none" }`. Eliminates self-signaling.

### 2.2 Execution Layer (`executeSignalPlan`)

`executeSignalPlan` is a thin executor that receives a `SignalPlan`:

```ts
export interface ExecuteSignalPlanOptions {
  /** Optional process.kill replacement for testing the execution layer. Defaults to process.kill. */
  processKill?: ((pid: number, signal: NodeJS.Signals | number) => boolean | void) | undefined;
}

export function executeSignalPlan(
  plan: SignalPlan,
  options: ExecuteSignalPlanOptions = {},
): boolean {
  if (plan.kind === "none") {
    return false;
  }

  const killFn = options.processKill ?? process.kill;

  if (plan.kind === "group") {
    try {
      killFn(-plan.pgid, plan.signal);
      return true;
    } catch {
      // Group signal failed (e.g. ESRCH or child not group leader); fall back to direct target.kill
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

export function signalOwnedChild(
  target: TerminableProcess | null | undefined,
  signal: NodeJS.Signals,
  options: PlanSignalOptions & ExecuteSignalPlanOptions = {},
): boolean {
  return executeSignalPlan(planSignal(target, signal, options), options);
}

export function signalSubtree(
  target: TerminableProcess | null | undefined,
  signal: NodeJS.Signals,
  options: ExecuteSignalPlanOptions = {},
): boolean {
  return signalOwnedChild(target, signal, { ...options, group: true });
}
```

### 2.3 Policy on Mutation Testing (M2)
- All guard mutation testing (inverting PID checks, disabling liveness checks, testing boundary inputs) is **exclusively executed against the pure function `planSignal`**.
- Because `planSignal` makes zero system calls, mutations cannot emit real signals regardless of test environment or missing mocks.
- Running package-wide integration suites under a mutated guard state is strictly prohibited.

---

## 3. Sandboxed Test Environment: Guaranteed `/tmp` Isolation (M3, S2, S3)

### 3.1 Test Harness Isolation via `TMPDIR` Scratch
Rather than relying on individual test authors to remember passing options (M3), test environment isolation is enforced globally by Vitest setup:

1. **Vitest Setup File (`test/setup_tmpdir.ts`)**:
   Registered in `wrapper/antigravity/vitest.config.ts`:
   ```ts
   import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
   import { tmpdir } from "node:os";
   import { join } from "node:path";
   import { afterAll } from "vitest";

   const realTmp = process.env.TMPDIR ?? "/tmp";
   const scratchRoot = mkdtempSync(join(realTmp, "kaoiro-agy-test-scratch-"));
   process.env.TMPDIR = scratchRoot;

   afterAll(() => {
     try {
       rmSync(scratchRoot, { recursive: true, force: true });
     } catch {}
   });
   ```
2. **`os.tmpdir()` Dynamic Evaluation**:
   Verified: In Node.js on Linux, `os.tmpdir()` evaluates `process.env.TMPDIR` on every call.
   All invocations of `mkdtempSync(join(tmpdir(), "kaoiro-agy-"))` and `sweepStaleCustomizationDirs()` in any test automatically fall into `scratchRoot`. Real `/tmp` is completely untouched.
3. **Dedicated Isolation Pin (`test/tmpdir_isolation.test.ts`)**:
   - Asserts `tmpdir()` starts with the scratch prefix and is strictly not `/tmp`.
   - Mutation check: disabling `setup_tmpdir.ts` in `vitest.config.ts` fails this pin.

### 3.2 S2 & S3 Alignments
- **S2**: `sweepCustomizationDirs: boolean` switch is dropped from `AntigravityHostOptions`. Stale sweeping runs by default in both production and tests; tests are protected by `TMPDIR` isolation.
- **S3**: `customizationBaseDir?: string` is added to `AntigravityHostOptions` and passed into `CustomizationDir.create({ baseDir: this.#options.customizationBaseDir })` and `sweepStaleCustomizationDirs({ baseDir: this.#options.customizationBaseDir })`. In `CustomizationDir.create`, directory creation uses `join(options.baseDir ?? tmpdir(), "kaoiro-agy-")`.

### 3.3 Fail-Closed Hardening in `processIsAlive` (S1)
In `wrapper/antigravity/src/customization.ts`:
```ts
function processIsAlive(pid: number, killFn: (pid: number, signal: number) => void = process.kill): boolean {
  // S1: Unverified or invalid PIDs are treated as ALIVE (fail-closed) so foreign/corrupt markers are never deleted
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) {
    return true;
  }
  try {
    killFn(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH confirms the process is definitively dead
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
```

---

## 4. Elimination of Global `process.kill` Mocks & Gate (M5)

1. **Complete Removal**:
   All `vi.spyOn(process, "kill")` and `process.kill = ...` calls are removed from all files in `wrapper/antigravity/test/` (including `host_subtree_termination.test.ts`, `subtree_termination.test.ts`, and `usage_probe.test.ts`).
2. **Injection Seams for Unit Tests**:
   - `executeSignalPlan` accepts `options.processKill`.
   - `usage_probe.ts` functions accept `options.processKill` or test pure `planSignal`.
   - `host_subtree_termination.test.ts` injects `signalSubtree?: (target, signal) => boolean` into `AntigravityHostOptions` to record signals without issuing OS syscalls.
3. **Static Contract Gate (`test/no_process_kill_mock_gate.test.ts`)**:
   - Reads every `.ts` and `.js` file in `wrapper/antigravity/test/`.
   - Asserts absence of regex `/(spyOn\(\s*process\s*,\s*["']kill["']|\bprocess\.kill\s*=)/`.
   - Mutation check: adding a dummy spy to any test file fails this gate.

---

## 5. Production Default Configuration Tests (M4)

To guarantee that components assembled with production defaults are fully exercised without injection, three specific tests are implemented:

1. **Production Subtree Termination (`subtree_termination_real_process.test.ts`)**:
   - Spawns a real tree: Parent -> Child -> Grandchild (`detached: true`).
   - Runs `signalSubtree` **with no injected options** using production defaults.
   - Asserts that both Child and Grandchild are terminated.
   - **Mutation**: Changing `signalSubtree`'s `group: true` to `group: false` leaves Grandchild running, failing the test.
2. **Production Usage Probe Lifecycle on `host.close()`**:
   - Spawns a real probe subprocess via `runAgyUsageProbe` running a long-lived benign helper (`node -e 'setInterval(()=>{},1000)'`).
   - Invokes `host.close()` (which calls `killChildGroup` / `signalOwnedChild` on the probe child).
   - Asserts that the probe child process group is terminated cleanly with no surviving orphan processes.
3. **Production Stale Customization Sweep**:
   - Under M3's isolated `TMPDIR` scratch:
   - Spawns a real child process, waits for its exit to obtain a guaranteed dead PID, and writes a valid `.kaoiro-owner.json` marker.
   - Writes a second directory with `process.pid` (guaranteed live PID).
   - Instantiates `new AntigravityHost()` **with no sweep or processIsAlive injections**.
   - Asserts dead PID directory is deleted and live PID directory is preserved.

---

## 6. /usage Probe Mapping & Negative Controls (N1)

### 6.1 Mapping Rules (Based on agy 1.2.14 Evidence)
- **Model Resolution**:
  - `gemini-*` -> maps to `gemini-*` buckets (`gemini-5h` -> `five_hour`, `gemini-weekly` -> `seven_day`).
  - `claude-*`, `gpt-*` -> maps to `3p-*` buckets (`3p-5h` -> `five_hour`, `3p-weekly` -> `seven_day`).
  - Unknown/unmapped models -> returns `null` (rate limits omitted from snapshot).
- **Metric Mapping**:
  - `utilization`: `Math.max(0, Math.min(1, 1 - remaining_fraction))`.
  - `resets_at`: Unix epoch seconds (`Math.floor(Date.parse(reset_time) / 1000)`), included **only** when `remaining_fraction < 1.0`. For unused buckets (`remaining_fraction >= 1.0`), `reset_time` is a moving placeholder and is omitted.
  - `status`: omitted in normal operation; `"blocked"` when `remaining_fraction <= 0`.
  - Terminal 429 (`RESOURCE_EXHAUSTED`) on turn results sets `seven_day: blocked`, which overrides probe results until a subsequent turn succeeds.
- **Probe Execution Boundaries**:
  - Spawns only at turn boundaries (after `result`), never mid-turn.
  - Throttled to at most once per 5 minutes, except at startup or when past a known blocked `resets_at`.
  - 10-second timeout; child spawned with `detached: true` in its own process group.
  - Suppressed after 3 consecutive failures until the next successful turn.

### 6.2 Negative Controls & Mutation Verification
1. **Unmapped Model**: Unknown model -> assert `rate_limits` undefined. (Mutation: default fallback -> red).
2. **Unused Bucket `resets_at` Omission**: `remaining_fraction: 1.0` -> assert `resets_at` undefined. (Mutation: remove check -> red).
3. **Probe Exit / Timeout**: Exit code 1 or 10s timeout -> assert wrapper survives, retains previous snapshot, suppresses after 3 failures.
4. **Malformed Payload**: Corrupt JSON / non-SUCCESS -> assert returns null without throwing.
5. **PID Guard Boundaries (`planSignal`)**:
   - Inputs: `undefined`, `null`, `0`, `1`, `-1`, `process.pid`, `NaN`, `1.5`, exited process (`exitCode: 0`).
   - Assert all return `{ kind: "none" }`.
   - Mutation: Removing `pid <= 1` or `pid === process.pid` fails this test.
6. **Sweep Fail-Closed**: Marker with non-integer PID or non-ESRCH error -> assert directory retained.
