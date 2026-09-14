---
title: Launcher-owned runner token pairing for dev.sh and dogfood.sh
status: proposed
date: 2026-09-14
opened: 2026-09-14
supersedes: []
superseded_by: null
related_specs: [auth-and-authz, deployment, setup-wizards]
related_adrs: [23, 31]
---

# ADR-0059 — Launcher-owned runner token pairing for dev.sh and dogfood.sh

## Status

Proposed (kohaku, 2026-09-14). Redesign requested by the operator after the
branch `fix-dev-runner-token` (f4597dd5 + three fix-forward commits) failed to
converge in four review rounds. Reviewed with fuji before implementation.

## Context

The runner authenticates to the server with `KAOIRO_RUNNER_TOKEN` (env only,
`runner/src/runner-cli.ts`). The server holds the pairing list
`KAOIRO_RUNNER_TOKENS=<host_id>:<token>,...` and parses it with
`Auth.parse_pairs/1` (split on `,`, first `:`, raw non-empty check, trim,
last entry wins). In `:prod` an empty list rejects every runner (issue #138);
in `:dev` it disables runner auth.

Two launchers must hand both sides a matching value:

| Launcher | Server | How the server receives `KAOIRO_RUNNER_TOKENS` |
| --- | --- | --- |
| `scripts/dev.sh` | `mix phx.server` (`:dev`) on the host | dev.sh `source`s `server/.env` (bash semantics) and mix inherits the env |
| `scripts/dogfood.sh` | release image via docker compose (`:prod`) | Compose `env_file: .env` (Compose's own parser: unquoted trailing whitespace and inline `# comments` stripped, quotes removed, last assignment wins) |

The failed branch tried to answer "which token does the server hold for this
host?" by re-parsing `server/.env` in shell and then re-implementing
`parse_pairs` in awk. Each review round found another divergence: trim
order, CR/LF, the caller's record terminator, and finally Compose's
env_file semantics. Two parsers were being reproduced in a third language,
and a bash `source` and a Compose `env_file` do not even agree with each
other on the same bytes. Adding string cases cannot close that class.

## Decision

Stop deriving the token from the server's list. The launcher owns the dev
host's pairing and hands the same value to both sides, so no parser is
reproduced anywhere.

### D1 — One source of truth: `runner/runner.env`

The dev host's token lives in `runner/runner.env`, the same file and format
the setup wizard writes (`runner/src/setup.ts`, mode 0600, gitignored). The
launcher creates it on first run with a freshly minted 64-hex token:

```text
KAOIRO_RUNNER_TOKEN=<64 hex>
```

Reading it back is a strict-format check the launcher authored, not a
parser: the last `KAOIRO_RUNNER_TOKEN=` line must match
`^KAOIRO_RUNNER_TOKEN=([0-9a-f]{64})$` after stripping one trailing CR.
Anything else is "operator-managed" (see D4). `runner/.gitignore` gains
`runner.env` (it currently ignores only `runner.config.json`).

`host_id` comes from `runner/runner.config.json` as today (generated on
first run, `[A-Za-z0-9._-]+` validated in both launchers, not only dogfood).

### D2 — dev.sh: append the pair, never parse

After sourcing `server/.env`, dev.sh exports for the server

```text
KAOIRO_RUNNER_TOKENS="${KAOIRO_RUNNER_TOKENS:+$KAOIRO_RUNNER_TOKENS,}$host_id:$token"
```

and for the runner `KAOIRO_RUNNER_TOKEN=$token`. The server's last-entry-wins
rule makes the appended pair authoritative for `host_id` whatever the
operator wrote before it, so an operator list for other hosts keeps working
untouched. mix and the runner receive the values from the same shell, so
parity is by construction. Runner auth is therefore always on under dev.sh;
the ":dev with auth off" mode is no longer reachable from dev.sh (it remains
reachable by running mix by hand).

A pre-set `KAOIRO_RUNNER_TOKEN` in the environment still wins for the runner
and is appended for the server the same way.

### D3 — dogfood.sh: manage exactly one pairing line

dogfood cannot append to the container's env at runtime (Compose reads
`env_file` literally, and interpolating a shell variable into
`docker-compose.yaml` would change the production file's semantics). It
therefore manages the pairing line in `server/.env` itself and checks it by
**exact comparison**, not by parsing:

1. Derive the expected line `KAOIRO_RUNNER_TOKENS=<host_id>:<token>` from
   `runner.env`.
2. Take the last `KAOIRO_RUNNER_TOKENS=` line of `server/.env` (strip one
   trailing CR). Compose also lets the last assignment win, so "last line"
   is the only Compose rule the launcher relies on.
   - No such line: append the expected line (with the existing sentinel
     comment) and `chmod go-rwx`.
   - Line equal to the expected line: nothing to do.
   - Any other line: fail closed before anything starts (D4).

Because the line dogfood wrote contains no quotes, whitespace or comments,
Compose delivers it to the server byte-for-byte; the server's `parse_pairs`
then yields `host_id => token`. Both sides hold the value the launcher
minted. No Compose semantics beyond "last assignment wins" are reproduced.

### D4 — Operator-managed pairing is explicit, not guessed

If `server/.env` carries a `KAOIRO_RUNNER_TOKENS` line the launcher did not
derive (an operator list shared with a real deployment, a hand-edited value,
a quoted or commented line), the launcher does not try to understand it. It
fails closed with the three ways out:

- `export KAOIRO_RUNNER_TOKEN=<token>` before running (the launcher then
  trusts the operator: dev.sh appends the pair, dogfood requires the line to
  contain `<host_id>:<that token>` as a plain substring check and otherwise
  still stops);
- put the host's token into `runner/runner.env` and make the `.env` line
  equal to the expected line;
- delete the line and let dogfood re-mint.

Silently choosing a different token than the server holds — the failure
mode of every previous round — is not among the outcomes.

### D5 — Migration of existing dogfood-minted lines

Lines minted by the previous dogfood (`KAOIRO_RUNNER_TOKENS=<host_id>:<64
hex>`, preceded by the "Added by scripts/dogfood.sh" comment) are adopted:
when `runner/runner.env` does not exist yet and the last line matches that
exact shape for this `host_id`, the launcher writes the token into
`runner/runner.env` instead of minting a new one. This is a strict-format
match on a line the launcher authored, not a parser.

### D6 — Shared library and tests

`scripts/lib/runner-token.sh` is replaced by `scripts/lib/runner-pairing.sh`
with these functions, each unit-tested through `node --test`
(`scripts/test/runner-pairing.test.mjs`) by running the real bash functions
against fixture files:

| Function | Contract |
| --- | --- |
| `pairing_host_id CONFIG` | host_id from runner.config.json, validated, or fail |
| `pairing_ensure_runner_env PATH HOST_ID SERVER_ENV` | create runner.env (mint or adopt per D5); print the token |
| `pairing_expected_line HOST_ID TOKEN` | `KAOIRO_RUNNER_TOKENS=HOST_ID:TOKEN` |
| `pairing_server_env_status SERVER_ENV EXPECTED_LINE` | prints `absent` / `match` / `other` |
| `pairing_append_line SERVER_ENV EXPECTED_LINE` | append with sentinel comment, chmod |

Negative controls: `other` for a quoted line, a commented line, trailing
whitespace, and a different token; `match` for the exact line and for the
same line with CRLF; adoption refuses a 63-hex token. The old awk parser and
its tests are deleted.

### D7 — Out of scope

Process management in both scripts (job control, log rotation, teardown)
is unchanged. The server's `parse_pairs` is unchanged. Multi-host lists
remain an operator concern handled through D4.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Keep re-parsing `server/.env` and the pair list in shell (the failed branch) | Reproduces two parsers (bash `source` / Compose `env_file`, plus `parse_pairs`) in awk; four rounds each found a new divergence |
| Read the Compose-resolved value with `docker compose config --format json`, then parse pairs | Fixes the env_file half only; still re-implements `parse_pairs`, and dev.sh has no Compose |
| Ask the server to resolve the host's token (`mix run -e` / release `eval`) | Exact by construction, but needs a compiled server before the launcher can decide, and a new public function whose only caller is a dev script |
| Interpolate `${KAOIRO_RUNNER_TOKENS}` into `docker-compose.yaml` | Changes production semantics: an unset shell variable would override the env_file value with an empty string |
| Add `KAOIRO_RUNNER_TOKENS_EXTRA` to the server | Server change for a launcher concern; two lists to reason about in `:prod` |

## Consequences

- No parser lives in the launchers. The only string rules kept are "last
  assignment wins" (shared by bash, Compose and the server) and strict
  matches on lines the launcher wrote.
- dev.sh always runs with runner auth on. Anyone relying on the unset-list
  "auth off" mode under dev.sh must set the token pair explicitly or run mix
  by hand.
- `runner/runner.env` becomes the second gitignored per-host secret next to
  `server/.env`; both are 0600.
- An operator who hand-manages the pairing gets a fail-closed stop with
  instructions instead of a silent mismatch. This is a behaviour change from
  the old dogfood, which tried to read any list.
- The branch `fix-dev-runner-token` is superseded: its helper is deleted, its
  dev.sh reordering (resolve before launching anything) is kept.
