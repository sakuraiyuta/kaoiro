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

Proposed (kohaku, 2026-09-14; revision 2 after fuji's design review, which
replaced the `.env` line matching of revision 1 with a Compose override).
Redesign requested by the operator after the branch `fix-dev-runner-token`
(f4597dd5 + three fix-forward commits) failed to converge in four review
rounds.

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
| `scripts/dogfood.sh` | release image via docker compose (`:prod`) | Compose `env_file: .env` (Compose's own parser: `export VAR=` and `VAR = ` forms, quoting, inline comments, last assignment wins) |

The failed branch tried to answer "which token does the server hold for this
host?" by re-parsing `server/.env` in shell and then re-implementing
`parse_pairs` in awk. Each review round found another divergence: trim
order, CR/LF, the caller's record terminator, and finally Compose's
env_file semantics. Two parsers were being reproduced in a third language,
and a bash `source` and a Compose `env_file` do not even agree with each
other on the same bytes. Revision 1 of this ADR still matched "the last
`KAOIRO_RUNNER_TOKENS=` line" of `.env`; fuji measured with
`docker compose config --format json` (v5.3.1) that Compose's last
assignment can be an `export KAOIRO_RUNNER_TOKENS=` or
`KAOIRO_RUNNER_TOKENS = ` line, and that an identical-looking line inside a
multi-line quoted value of another variable is not an assignment at all.
Any inspection of `.env` content is a parser. The launchers must not read
`.env` for this value at all.

## Decision

The launcher owns the dev host's pairing, hands the same token to the
runner, and **appends** its pair to the value the server is already going
to receive, through the same mechanism that delivers that value. Nothing is
parsed: the only rule relied on is the server's "last entry wins", which
makes the appended pair authoritative for `host_id` while preserving every
other host the operator listed.

### D1 — One source of truth: `runner/runner.env`

The dev host's token lives in `runner/runner.env` (gitignored; `runner/.gitignore`
currently ignores only `runner.config.json` and gains this entry). The
launcher creates it on first run, mode 0600, with a freshly minted token:

```text
KAOIRO_RUNNER_TOKEN=<64 hex>
```

This is the launcher's own local-dev file. It shares the variable name and
line shape with the setup wizard's `runner.env` (`runner/src/setup.ts`), but
the wizard writes to the OS user config dir and quotes the value
(`KAOIRO_RUNNER_TOKEN='<hex>'`), so the two are not the same file. Reading
back is a strict-format check, not a parser: the last `KAOIRO_RUNNER_TOKEN=`
line must match `^KAOIRO_RUNNER_TOKEN=(['"]?)([0-9a-f]{64})\1$` after
stripping one trailing CR (the optional matching quotes accept a file the
operator copied from the wizard). Anything else fails closed with the
message "runner/runner.env is not in the launcher format; fix or delete
it". An existing file keeps its mode; a file the launcher writes is 0600.

`host_id` comes from `runner/runner.config.json` as today (generated on
first run, `[A-Za-z0-9._-]+` validated in both launchers, not only dogfood).

### D2 — Token charset: managed and preset alike

A token the launcher appends must survive the server's split rules
unchanged: no `,`, no whitespace, no control characters, no leading or
trailing characters the server trims. Managed tokens are 64 hex. A preset
`KAOIRO_RUNNER_TOKEN` in the environment wins over `runner.env` but must
match `^[A-Za-z0-9._~+/=:-]{16,}$` (a `:` is allowed because the server
splits on the first colon only); otherwise the launcher stops before
starting anything and says why. fuji measured that a preset `one,h:two`
would otherwise register `h => two` on the server while the runner presents
`one,h:two`.

### D3 — dev.sh: append the pair to the sourced value

After sourcing `server/.env` (bash semantics — exactly what mix receives),
dev.sh exports for the server

```text
KAOIRO_RUNNER_TOKENS="${KAOIRO_RUNNER_TOKENS:+$KAOIRO_RUNNER_TOKENS,}$host_id:$token"
```

and for the runner `KAOIRO_RUNNER_TOKEN=$token`. mix and the runner receive
the values from the same shell, so parity is by construction. Runner auth
is therefore always on under dev.sh. Note the blast radius: the old
unset-list "auth off" mode admitted any runner from any host; under dev.sh
every runner that joins this mix, not only `dev-host`, now needs a pair in
the list (the operator's entries for other hosts are preserved by the
append).

### D4 — dogfood.sh: read the Compose-resolved value, append, inject through a launcher override

dogfood does not write `server/.env` and does not read it. Instead:

1. Resolve what Compose will hand the server from the base file only:
   `docker compose -f docker-compose.yaml config --format json`, read
   `.services.kaoiro.environment.KAOIRO_RUNNER_TOKENS` with node. The
   service `kaoiro` must exist in the output (otherwise stop: the base file
   is not the one this launcher knows); only a missing variable on an
   existing service is treated as an empty list. This is Compose's own
   env_file parser, so the value is exact by construction, including
   `export` forms, quoting and comments.
2. Append the launcher's pair exactly as D3 does.
3. Inject the result through a **tracked, launcher-only override file**
   `server/docker-compose.dogfood.yaml`:

   ```yaml
   services:
     kaoiro:
       environment:
         KAOIRO_RUNNER_TOKENS: ${KAOIRO_LAUNCHER_RUNNER_TOKENS:?dogfood.sh sets this}
   ```

   dogfood runs every compose command (`up`, `logs`, `down`) with
   `-f docker-compose.yaml -f docker-compose.dogfood.yaml` and exports
   `KAOIRO_LAUNCHER_RUNNER_TOKENS`. The `:?` form makes a missing variable a
   `config` error instead of an empty-string override (measured by fuji:
   exit 1 when unset, exit 0 with the service value byte-identical when
   set). Production keeps using `docker-compose.yaml` alone; the override
   file contains no secret and changes nothing for anyone who does not pass
   `-f` twice.

The environment value the server sees is then `<operator's resolved
list>,<host_id>:<token>` and `parse_pairs` yields `host_id => token`.
Operator-managed entries for other hosts survive untouched, a stale
`dev-host` entry an older dogfood minted into `.env` is overridden by the
appended pair, and no `.env` bytes are ever interpreted by the launcher.

### D5 — No `.env` migration

Because the pair is appended rather than looked up, lines an older dogfood
minted into `server/.env` need no adoption and no removal: the server takes
the appended pair. The first run with this design mints a new token into
`runner/runner.env`; the old value in `.env` becomes dead weight the
operator may delete. dogfood's "mint into `.env`" step and its sentinel
comment are removed.

### D6 — Shared library and tests

`scripts/lib/runner-token.sh` is replaced by `scripts/lib/runner-pairing.sh`:

| Function | Contract |
| --- | --- |
| `pairing_host_id CONFIG` | host_id from runner.config.json, validated, or fail |
| `pairing_ensure_runner_env PATH` | create `runner.env` (mint) when absent; print the token; fail on a non-launcher format |
| `pairing_check_token TOKEN` | D2 charset check; fail with reason |
| `pairing_append LIST HOST_ID TOKEN` | `LIST` empty → `HOST_ID:TOKEN`, else `LIST,HOST_ID:TOKEN`; prints without newline |

Tests (`scripts/test/runner-pairing.test.mjs`, `node --test`, running the
real bash functions):

- unit: mint creates a 0600 file with 64 hex; reads back unquoted, single-
  and double-quoted forms; rejects 63 hex, a second line with junk, and a
  quoted mismatch; `pairing_check_token` rejects comma, space, tab, CR,
  empty and 15-char values; `pairing_append` on empty and non-empty lists.
- caller paths: run the real `scripts/dev.sh` and `scripts/dogfood.sh` with
  the service launches stubbed (the technique fuji used in review) and
  assert the exact `KAOIRO_RUNNER_TOKENS` / `KAOIRO_RUNNER_TOKEN` /
  `KAOIRO_LAUNCHER_RUNNER_TOKENS` values the stubs receive, for: no `.env`
  list, an operator list for other hosts, a stale `dev-host` line, a preset
  token, and a preset token with a comma (must stop before any launch).
- Compose effective environment: when `docker compose` is available, run
  `config --format json` with both files and assert the `kaoiro` service's
  `KAOIRO_RUNNER_TOKENS` equals the appended value; skip with a visible
  notice otherwise. Negative control: unset `KAOIRO_LAUNCHER_RUNNER_TOKENS`
  → `config` exits non-zero.

The old awk parser and its tests are deleted.

### D7 — Out of scope

Process management in both scripts (job control, log rotation, teardown)
is unchanged except that dogfood's compose invocations gain the second
`-f`. The server's `parse_pairs` is unchanged. The production
`docker-compose.yaml` is unchanged.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Re-parse `server/.env` and the pair list in shell (the failed branch) | Reproduces two parsers (bash `source` / Compose `env_file`, plus `parse_pairs`); four rounds each found a new divergence |
| Match "the last `KAOIRO_RUNNER_TOKENS=` line" of `.env` exactly (revision 1 of this ADR) | Still a parser: Compose's last assignment may be an `export` or spaced form, and a look-alike line inside a quoted value is not an assignment (fuji, compose v5.3.1) |
| Read the Compose-resolved value, then look the host up with a pair parser | Fixes the env_file half only; the pair parser stays. Reading the resolved value is kept, the lookup is replaced by append |
| Ask the server to resolve the host's token (`mix run -e` / release `eval`) | Exact, but needs a compiled server before the launcher can decide, and a new public function whose only caller is a dev script |
| Interpolate `${KAOIRO_RUNNER_TOKENS}` into the production `docker-compose.yaml` | Changes production semantics; an unset shell variable would override the env_file value. The launcher-only override with `:?` avoids both |
| Add `KAOIRO_RUNNER_TOKENS_EXTRA` to the server | Server change for a launcher concern; two lists to reason about in `:prod` |

## Consequences

- No parser lives in the launchers. The only rules relied on are the
  server's "last entry wins" and strict matches on a file the launcher
  wrote (`runner.env`).
- dev.sh always runs with runner auth on, for every runner joining that
  mix. Anyone relying on the unset-list "auth off" mode under dev.sh must
  set pairs explicitly or run mix by hand.
- `runner/runner.env` becomes the second gitignored per-host secret next to
  `server/.env`; both are 0600 when the launcher creates them.
- dogfood stops mutating `server/.env`. A tracked override file appears next
  to `docker-compose.yaml`; documentation (`server/README.md`,
  `docs/specs/deployment.md`) must say it is for dogfood only.
- The branch `fix-dev-runner-token` is superseded: its helper is deleted;
  its dev.sh reordering (resolve before launching anything) is kept.
