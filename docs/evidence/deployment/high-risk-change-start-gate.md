---
title: High-risk change start gate evidence
description: Measured behaviour of the production-shape start gate in the high-risk change runbook, with its strict env-line grammar controls, single-guard mutations, a throwaway-install-root run and the limits of what it covers.
status: recorded
last_updated: 2026-10-09
related: [deployment]
---

# High-risk change start gate evidence

**Measurement record (2026-10-09, linux-host / Linux 7.0.0-38-generic, systemd
user instance, `/bin/sh` = dash, Node v22.23.3).** The block in
[High-risk change release § 3](../../operations/high-risk-change-release.md#3-production-shape-start)
(60 lines, SHA-256 `0901f9a3a713a1e5ab80e54f043742e1ec194afd112a5755bafb09b77464bc2d`)
was extracted unchanged from the page and run as `sh gate.sh <shim> <id>`.
Documentation commit base: `0bfede23`. Nothing here exercises the canary stage
(runbook section 4), which has not been run on a real update.

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

What this shows, and what it does not: of the three env-grammar layers, the
production-line check is the only one that is load-bearing on its own. The
strict copy and the fixture-content check overlap with it and with each other,
so removing either one alone changes nothing; each is pinned only in
combination (mut-b, mut-c). They are kept as layers, not as separately pinned
guards.

## Other preconditions and loader acceptance

| Case | Setup | Result |
|---|---|---|
| U1 | a `systemctl` stub reporting `Environment=FOO=bar` for the unit (the live unit reports none) | `GATE STOP: the unit sets Environment=`, marker absent |
| E1 | production env that is not valid shell | `GATE STOP: production env is not valid shell`, marker absent |
| L1 | a listener on port 59999 | `GATE STOP: port 59999 is not free`, marker absent |
| C1 | production config with an invalid `codex.backend`, live shim | the candidate's loader rejects it: `GATE STOP: exit is 1, expected 124` |
| V1 | `KAOIRO_CLAUDE_TURN_WATCHDOG_INACTIVITY_MS=abc`, live shim | the loader rejects it: `GATE STOP: exit is 1, expected 124` |
| V2 | `KAOIRO_CODEX_TURN_WATCHDOG_INACTIVITY_MS=abc`, live shim | **`GATE PASS`**: the gate does not validate a Codex variable |

V2 is a limit of the gate, not a pass of the value: the fixture enables only the
`claude-code` capability, and the runner neither reads nor validates a behaviour
variable of an engine that is not in `capabilities`
([Behaviour settings](../../reference/configuration/runner.md#behaviour-settings)).
Config blocks of every engine are validated (C1). Codex and Antigravity
variables are first validated when the real runner starts.

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

## Limits

- Native probes, wrapper spawn, a real connection and registration, and any
  model turn are outside the gate by design.
- Linux and systemd only: the block uses `ss` and `systemctl --user`.
- The Node used is the one the user manager's `PATH` and `runner.env` resolve on
  this host (`/usr/bin/node`). A version-managed Node shim that cannot run with
  an empty `HOME` was not measured on this host.
- The throwaway-root run used a retained earlier release, not a candidate built
  from a change under review.
- These are tier (c) probe runs: the harness is not part of the repository.
