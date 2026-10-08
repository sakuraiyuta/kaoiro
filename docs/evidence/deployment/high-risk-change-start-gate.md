---
title: High-risk change start gate evidence
description: Measured behaviour of the production-shape start gate in the high-risk change runbook, with its strict env-line grammar controls, single-guard mutations, a throwaway-install-root run and the limits of what it covers.
status: recorded
last_updated: 2026-10-09
related: [deployment]
---

# High-risk change start gate evidence

**Measurement record (2026-10-09, linux-host / Linux 7.0.0-38-generic, systemd
user instance, `/bin/sh` = dash, Node v22.23.3).** Two versions of the block in
[High-risk change release § 3](../../operations/high-risk-change-release.md#3-production-shape-start)
were measured, each extracted unchanged from the page and run as
`sh gate.sh <shim> <id>`:

| Version | Page commit | Lines | SHA-256 |
|---|---|---|---|
| First | `f16b141c` | 60 | `0901f9a3a713a1e5ab80e54f043742e1ec194afd112a5755bafb09b77464bc2d` |
| Revised after review | the commit that follows `f16b141c` | 71 | `67d466664e41583435746e5b47ff40c6166b5a73894f9a2a0fc67b567de29352` |

The first version's tables below are kept as measured. The revised block's
controls are in "Revised block (after review)". Documentation base: `0bfede23`.
Nothing here exercises the canary stage (runbook section 4), which has not been
run on a real update.

## Targets

| Target | What it is | Used for |
|---|---|---|
| Live release shim | `current` of the production install root, release `bf02a928b9bd170d94aa3a0c049cd4197c1b0a91`, started read-only | Positive controls and loader-rejection controls |
| Synthetic production settings | A scratch `XDG_CONFIG_HOME` with the repo's example config and an env file of made-up lines (dummy token) | Every control below except the one real-production run |
| Tripwire shim | A script that only touches a marker file and sleeps | Proving that a control stops **before** the start: the marker must stay absent |
| Throwaway install root | The retained release tarball `004e76fb…` installed and switched with the live release's scripts into a scratch root | Release-layout run and the missing-file control |
| Real production settings | The host's own `runner.config.json` and `runner.env`, read-only | One positive run; values were not printed. The copied-names list was empty (the env file holds no behaviour variable) and the files' mtime and size were the same before and after |

## Strict env-line grammar controls (live release shim or tripwire)

The grammar: a production line that names a behaviour variable must be
`[export ]NAME=VALUE`, `VALUE` in `[A-Za-z0-9._:/+-]*`, optionally in one pair
of matching quotes; comment lines are ignored. Anything else stops the gate
before the start.

| Case | Production env line | Shim | Result |
|---|---|---|---|
| P0 | token only | live | `GATE PASS`, exit 0 |
| P1 | `KAOIRO_CLAUDE_PHASE2_DELIVERY=0` | live | `GATE PASS`; name printed |
| P2 / P2b | a valid value in double / single quotes | live | `GATE PASS`; name printed |
| P3 | `export KAOIRO_CLAUDE_PHASE2_DELIVERY=0` | live | `GATE PASS` |
| P4 | `KAOIRO_RUNNER_SERVER_URL=ws://127.0.0.1:59998/runner` (not a behaviour variable) | live | `GATE PASS`; the line is not copied |
| P5 | a comment line that mentions a behaviour variable | live | `GATE PASS` |
| N-a | `NAME=0; KAOIRO_RUNNER_SERVER_URL=ws://127.0.0.1:59998/runner` | tripwire | `GATE STOP`, exit 1, marker absent |
| N-b | `NAME=$(echo 0)` | tripwire | `GATE STOP`, marker absent |
| N-c | two leading blanks before the line | tripwire | `GATE STOP`, marker absent |
| N-d | two assignments on one line | tripwire | `GATE STOP`, marker absent |
| N-e | backtick substitution | tripwire | `GATE STOP`, marker absent |
| N-f | `export` followed by a tab | tripwire | `GATE STOP`, marker absent |
| N-g | double-quoted `$HOME` | tripwire | `GATE STOP`, marker absent |
| N-h | trailing `# off` | tripwire | `GATE STOP`, marker absent |
| N-i | a space before `=` | tripwire | `GATE STOP`, marker absent |
| T0 | a valid env with the tripwire shim | tripwire | marker **present**, then `GATE STOP` (no host line): the tripwire does record a start |

**The URL-line case on the production path is P4, not a fixture write.** An
earlier prototype of the gate had a test hook that wrote a URL line straight
into the fixture env, to prove the fixture-content check. On the real path a
production URL line never reaches the fixture, because the copy filter drops it
(case P4: `GATE PASS`, nothing copied). The two measure different things: P4 is
the production path, the hook exercised the check on the fixture file. The
published block has no test hook.

### Sensitivity of the controls

The same cases were run against the earlier loose grammar and against the
published block with guards removed. A control is only evidence if it fails when
the guard is gone.

| Variant | Guard removed | N-a to N-i |
|---|---|---|
| Earlier block (any value after an allowed name) | the whole strict grammar | all nine **start** (marker present) |
| mut-a | the production-line check only | all nine **start**: the near-miss lines are dropped silently by the strict copy, so the gate would pass without validating them |
| mut-b | mut-a, plus the copy filter loosened to any value | N-a, N-b, N-d, N-e, N-g, N-h stop at the fixture-content check; N-c, N-f, N-i **start** (the loosened copy drops them) |
| mut-c | mut-b, plus the fixture-content check | all nine **start**; for N-a the injected line reaches the fixture |
| mut-d | the unit `Environment=` check | case U1 starts; N-a to N-i unchanged |
| mut-e | the `sh -n` check on the production env | E1 still stops, with the misleading reason `node is not an absolute path` |

What this shows, and what it does not: the guards protect two different
properties, and the controls pin them differently.

| Property | Guard sufficient on its own | What the controls show |
|---|---|---|
| The start cannot be redirected by a production line | The strict copy: the `;` line is not copied. The fixture-content check overlaps it, and the post-start line check is the backstop | With the production-line check removed (mut-a) the injected URL still never reaches the fixture. The fixture check is pinned only in combination: with the copy loosened it alone stops six of the nine near-miss lines (mut-b) |
| No line the gate claims to check is dropped silently | The production-line checks, alone | With only that check removed (mut-a) all nine near-miss lines are dropped and the gate passes without having validated them |

The strict copy and the fixture-content check are layers: removing either one
alone changes nothing, so neither is pinned as a separate guard.

## Other preconditions and loader acceptance

| Case | Setup | Result |
|---|---|---|
| U1 | a `systemctl` stub reporting `Environment=FOO=bar` for the unit (the live unit reports none) | `GATE STOP: the unit sets Environment=`, marker absent |
| E1 | production env that is not valid shell | `GATE STOP: production env is not valid shell`, marker absent |
| L1 | a listener on port 59999 | `GATE STOP: port 59999 is not free`, marker absent |
| C1 | production config with an invalid `codex.backend`, live shim | the candidate's loader rejects it: `GATE STOP: exit is 1, expected 124` |
| V1 | `KAOIRO_CLAUDE_TURN_WATCHDOG_INACTIVITY_MS=abc`, live shim | the loader rejects it: `GATE STOP: exit is 1, expected 124` |
| V2 | `KAOIRO_CODEX_TURN_WATCHDOG_INACTIVITY_MS=abc`, live shim | **`GATE PASS`**: the gate does not validate a Codex variable |

V2 in the first version is a limit of the gate, not a pass of the value: the fixture enables only the
`claude-code` capability, and the runner neither reads nor validates a behaviour
variable of an engine that is not in `capabilities`
([Behaviour settings](../../reference/configuration/runner.md#behaviour-settings)).
Config blocks of every engine are validated (C1). In the first version, Codex
and Antigravity variables were first validated when the real runner started;
the revised block stops on them (see below).

## Throwaway install root (release layout)

The retained tarball of release `004e76fb…` was installed and switched with the
live release's `kaoiro-runner-install.sh` and `kaoiro-runner-switch.sh` using
`--install-dir` on a scratch root. The tarball is not a candidate built from the
documented branch, and the scripts are the live release's, not the tarball's.

| Step | Result |
|---|---|
| install | exit 0, a 40-character release id on stdout |
| switch | exit 0, prints the same id; `current` names that release |
| G0: gate on the root's `current` shim with that id | `GATE PASS` |
| G1: gate with a different 40-hex id | `GATE STOP: the resolved-host line is not present exactly once` (stderr kept) |
| G2: `dist/args.js` removed from the release, same id | `GATE STOP: exit is 78, expected 124` (stderr kept; its first line is the verifier's `verify-release:` message) |

The scratch root and the kept stderr directories were removed after reading.

## Revised block (after review)

Changes: a production env line that sets a Codex or Antigravity behaviour
variable now stops the gate (the first version copied it and passed); the unit
precondition reads `Environment`, `EnvironmentFiles` and `PassEnvironment`; the
name lists are split into `carry`, `blind` and `paths`. Two further stops came
from closing the same class of gap: `KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS` is a
row the runner validates for every engine but the first version's name pattern
did not carry it, and a `KAOIRO_RUNNER_DIR`, `_CONFIG` or `_ENV` line in
`runner.env` would make production read other settings than the gate reads.

Controls on the revised block (live release shim or tripwire; synthetic settings
unless noted):

| Case | Production env or setup | Result |
|---|---|---|
| P0, P1, P2, P3 | token only; plain, double-quoted and `export` forms of a Claude variable | `GATE PASS`; the name is printed |
| P4, P5 | an unrelated URL line; a comment naming a variable | `GATE PASS`; nothing copied |
| P6 | `KAOIRO_CODEX_DEFAULT_MODEL=gpt-x` (no behaviour row) | `GATE PASS`: a name that is on no list is invisible to the gate |
| WP1 / WP2 | `KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS=60000` / `=abc` | `GATE PASS`, name printed / loader rejects: `GATE STOP: exit is 1, expected 124` |
| N-a to N-i | the nine near-miss lines (N-f is now an `export` plus tab form of a Claude variable) | all nine `GATE STOP`, exit 1, marker absent |
| T0 | a valid env with the tripwire shim | marker **present**, then `GATE STOP` (no host line) |
| V2 | `KAOIRO_CODEX_TURN_WATCHDOG_INACTIVITY_MS=abc` | `GATE STOP: ... a Codex or Antigravity variable that this gate cannot validate ... move it to its runner.config.json key`, marker absent |
| B-* | each of the eight Codex and Antigravity rows set to `1` | all eight `GATE STOP`, marker absent (the first version's P2b, a single-quoted `KAOIRO_CODEX_OPERATOR_STEER`, belongs here now) |
| K1 | `runner.config.json` with an invalid `codex.turn_watchdog_inactivity_ms`, live shim | the loader rejects it: `GATE STOP: exit is 1, expected 124`, so the advised config path is validated |
| X1, X2, X3 | `KAOIRO_RUNNER_CONFIG`, `KAOIRO_RUNNER_DIR`, `KAOIRO_RUNNER_ENV` in the env file | all three `GATE STOP`, marker absent |
| U1, U2, U3 | a `systemctl` stub that reports a value for `Environment`, `EnvironmentFiles` or `PassEnvironment` only when that property is asked for | all three `GATE STOP`, marker absent |
| E1, L1, V1, C1 | invalid shell env; port 59999 busy; invalid Claude variable; invalid `codex.backend` | `GATE STOP` for each (E1 and L1 before the start; V1 and C1: `exit is 1, expected 124`) |
| Real production settings | read-only, values not printed | `GATE PASS`, exit 0; the copied-names list was empty; the files' mtime and size were unchanged |
| G0, G1, G2 | throwaway root with the retained `004e76fb…` release (as above) | `GATE PASS`; wrong id `GATE STOP`; `dist/args.js` removed: `GATE STOP: exit is 78, expected 124` |

The first version on the same inputs (a reference run): WP2 `GATE PASS` (the
invalid permission timeout was dropped silently), V2 and X1 started the shim
(marker present), U1 stopped (it read `Environment` only).

Single-guard mutations of the revised block (markers read as before):

| Variant | Guard removed | Result |
|---|---|---|
| mut-a | the carried-line check | N-a to N-i: all nine **start** |
| mut-b | mut-a, plus the copy filter loosened to any value | N-a, N-b, N-d, N-e, N-g, N-h stop at the fixture-content check; N-c, N-f, N-i **start** |
| mut-c | mut-b, plus the fixture-content check | all nine **start** |
| mut-d | the unit properties reduced to `Environment` | U1 stops; U2 and U3 **start** |
| mut-e | the Codex and Antigravity check | V2 and all eight B-* cases **start** |
| mut-f | the path-variable check | X1, X2, X3 **start** |

## C1 observation (read-only, live unit)

`systemctl --user status kaoiro-runner --no-pager -l | grep -c
'node_modules/.pnpm/@kaoiro+'` printed 11 on the running fleet. Reading the
unit's `cgroup.procs` and counting only the matching package names showed
wrapper command lines for the claude-code and codex packages. No Antigravity
wrapper was running, so the pattern is not measured for it.

The runner journal logs each `spawn` it receives (`runner: phoenix receive: ...
spawn`). Since the unit's last start the journal held 9 such lines, all in the
same second, four seconds after the `runner: host=... connecting` line: a
restore of the fleet right after that update. The journal command in the runbook
(`--since` the unit's `ActiveEnterTimestamp`, accepted by `journalctl` on this
host) therefore prints 0 only before any restore, which is the state C1 checks.
An earlier look at only the last 400 journal lines saw none, because heartbeat
lines had pushed them out; the command must use `--since`.

## Limits

- Native probes, wrapper spawn, a real connection and registration, and any
  model turn are outside the gate by design.
- Linux and systemd only: the block uses `ss` and `systemctl --user`.
- The Node used is the one the user manager's `PATH` and `runner.env` resolve on
  this host (`/usr/bin/node`). A version-managed Node shim that cannot run with
  an empty `HOME` was not measured on this host.
- The throwaway-root run used a retained earlier release, not a candidate built
  from a change under review.
- The three name lists in the block follow `runner/src/behaviour-settings.ts` by
  hand. A name on no list is invisible to the gate (P6); nothing here checks the
  lists against the file.
- These are tier (c) probe runs: the harness is not part of the repository.
