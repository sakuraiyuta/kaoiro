---
title: Introduce build identity and separate it from the protocol version
status: accepted
date: 2026-08-12
opened: 2026-08-12
supersedes: []
superseded_by: null
related_specs: [deployment, protocol]
related_adrs: [15, 18, 23]
---

# ADR-0053 — Introduce build identity and separate it from the protocol version

## Status

Accepted

## Context

There was no way to say which commit a running artifact came from
([issue #218](https://github.com/sakuraiyuta/kaoiro/issues/218)). The server
router had no health / version endpoint, `runner` had no
`--version`, `server/Dockerfile` had no OCI label, and the
runner's register payload had no build revision — all of these were missing.

We nearly used file mtime as a substitute, but that does not work. The mtime of
the `dist` directory is not updated when no files are added or removed,
and there was an actual case where we nearly misread “three packages have
remained at their state from 10 days ago”, recorded in the runbook for
[issue #217](https://github.com/sakuraiyuta/kaoiro/issues/217) (section 4.5).

As an existing asset, `scripts/build-runner-tarball.sh` wrote the git
short SHA and a dirty marker to `VERSION`, but it needed full-SHA
conversion and a unified dirty definition.

**The protocol version in [ADR-0015](0015-protocol-version-stamping.md) is
wire-protocol compatibility, not artifact identity.** They are separate axes;
confusing them would lead to an incorrect design such as “a docs-only commit
causes a compatibility error”.

## Decision

Introduce a build identity separate from the protocol version
(only `revision` / `dirty`, plus `built_at` for the
runner). `revision` and `dirty` are the identity.

**`built_at` is a runner-only diagnostic field and is not carried by the
server** (issue #218 round 2 advisory 2, ふじ's rejection — the wording
“common BuildInfo shape” refers to the runner's `BuildInfo` (the
TypeScript type, `runner/src/build_info.ts`), and must make clear that
it is distinct from the server identity (only two fields,
revision/dirty). Otherwise a later implementation could misread this as
requiring built_at on the server. `built_at` is never used for
comparison — it embodies this ADR's central distinction that identity is about
“which commit it came from”, not “when it was written”, so using it for
comparison would contradict this ADR's premise.

**`built_at` is also subject to value-domain validation (issue #218
round 3, ふじ's rejection MF-4).** Its diagnostic-only purpose does not permit
arbitrary strings: only the canonical ISO-8601 format written by
`generate-build-info.mjs`, `new Date().toISOString()`, or the
literal `UNKNOWN_BUILD_INFO` / `"unknown"` is valid.

### Definition of dirty (one location)

Determine it from `git status --porcelain`, and treat **both tracked and
untracked** files as dirty. `git diff --quiet` does not see untracked
files, and in actual work for issue #217 an untracked file slipped past the
existing dirty check.

**Round 2 ruling (ふじ's rejection, MF-2):** If `git status --porcelain`
itself fails (an abnormal case where rev-parse succeeds but status fails),
**degrade the entire identity to `unknown`** — do not fall back to the
actual revision with `dirty: false`. “Degrading an inability to determine
the result to false” means saying everything is fine despite not knowing; it is
different from saying “unknown”. Do not make dirty tri-state (unknown/true/false):
that would increase the states to absent/unknown/dirty-unknown/dirty/
clean-mismatch/clean-match and only complicate the enforcement design for issue
#220. Keep the reason for degradation in logs for diagnosis (do not silently
return unknown).

This computation is performed in exactly one place,
`scripts/build-identity.mjs` at repository level (round 1 had implemented
it only in the runner's `generate-build-info.mjs`, leaving the server's
build-argument computation outside it; round 2 completed this unification).
`runner/scripts/generate-build-info.mjs` imports it and writes
`dist/build-info.json`. The server build procedure
(`docs/specs/deployment.md` 4.3) also calls the same script to obtain
`KAOIRO_BUILD_REVISION` / `KAOIRO_BUILD_DIRTY`.
`scripts/build-runner-tarball.sh` does not call
`git diff --quiet` itself; it reads the
`dist/build-info.json` written by `generate-build-info.mjs` and
builds `VERSION` (the `--format` mode). This structurally closes
the risk of definitions diverging through duplicate implementations.

**Round 3 ruling (ふじ's rejection, MF-3): `--format` also applies the same
value-domain validation.** Round 2's `--format` only read and formatted
the file and did not validate the domains of `revision` / `dirty` —
given a broken build-info.json such as
`{"revision":"not-a-sha","dirty":"false"}`, JavaScript truthiness treated
the string `"false"` as dirty and calmly output
`not-a-sha-dirty`. The runner's `loadBuildInfo()` degrades the same
file to `unknown`, while only `--format` passed through raw values,
which was inconsistent. The ruling is not to stop fail-loud, but to **degrade to
the same `unknown` as the runner** so readers behave the same for the same
file. Log the reason for degradation to stderr, as with the other paths.

### Runner: bake it into `dist` at build time (do not call git at startup)

The runner is also distributed as a tarball without git
([ADR-0018](0018-runner-distribution.md)). A distributed runner cannot run
`git rev-parse` at startup. In addition, even in repo-direct operation,
it is normal for `dist` to be from an older commit while only
`HEAD` has advanced — reporting `git rev-parse HEAD` at startup
would claim a build revision **unrelated to the artifact actually running**. This
is the same structure as the runbook's warning in issue #217 that mtime is not
evidence of success, and the same hole must not be reproduced in #218, which
asks “which commit did it come from?” rather than “when was it written?”.

Therefore calculate revision only at **build time** (as part of
`pnpm -C runner build`, immediately after `tsc` runs
`generate-build-info.mjs`), and bake it into `dist/build-info.json`
inside `dist/`. `cli.ts` only reads this file at startup and
never calls git. Repo-direct execution and tarball distribution use the same
path. If git is unavailable or the process is outside a repository, fail-soft
with `revision: "unknown"` — do not stop startup.

### Server: bake it into an image-baked file inside the image through build args

`.dockerignore` excludes `.git` from the build context (as its
“nothing in the build reads it” comment says). Therefore Dockerfile cannot run
`git rev-parse`, and **the build side must pass
`KAOIRO_BUILD_REVISION` / `KAOIRO_BUILD_DIRTY` as build args**
(pass the output of `scripts/build-identity.mjs` to
`docker compose build` — `docs/specs/deployment.md` 4.3).

**Round 1 followed the same `ARG` → `ENV` → `LABEL` pattern as
`KAOIRO_PLAIN_HTTP`, but round 2 judged this wrong (ふじ's rejection,
MF-1).** `ENV` can be overwritten at **container runtime** through
`docker run -e` or `docker-compose.yaml`'s
`env_file: .env` — it merely changed the name, returning the same
mistake rejected for the runner to the server: an identity that should be fixed
at build time remained replaceable at runtime. The existing decision not to
follow the `KAOIRO_PLAIN_HTTP` ARG/ENV pattern was correct, but merely
not writing to `.env` left the writable structure itself.

Therefore in the final stage generate an **image-baked file** inside the image,
`/app/build-info.json`, from `ARG`, and generate the OCI label
from the same ARG (so both necessarily match). `GET /api/health`
(`KaoiroServerWeb.HealthController`) reads this **file**, not
`System.get_env`, by following `RELEASE_ROOT`, an environment
variable that Mix release exports automatically at startup (it only indicates
the file's location).

**Terminology (issue #218 round 3 advisory 2, ふじ's rejection):** Call it
“image-baked”, not “immutable”. `/app` is owned by `nobody`,
and `build-info.json` is `chown nobody:root` — there is no
tamper-resistance against a running process inside the container, and this is
not attestation. The only guarantee is independence from container-RUN-time
environment variables.

Also make `dirty` an OCI label
(`com.kaoiro.build-dirty` — `dirty` is not reserved vocabulary
under `org.opencontainers.image.*`, so this is a project-custom label).
Round 2 baked dirty into `build-info.json` but forgot the label, so dirty
was invisible through provenance checks via `docker inspect` in
deployment.md 4.5 (issue #218 round 3 MF-1).

In local `mix phx.server` startup (development without Docker),
`RELEASE_ROOT` is not set, so return `"unknown"`. Do not provide
a git fallback — for the same reason as the runner, the checkout state and the
running artifact are unrelated. **It is normal for dev to show
`"unknown"`**, and this asymmetry makes it possible to identify
`"unknown"` in production as an abnormality.

### Value-domain validation (round 2, ふじ's rejection MF-3)

The valid domain of `revision` is only the literal
`"unknown"` or a lowercase 40-character hexadecimal git SHA, implemented
in exactly one place, `KaoiroServer.BuildIdentity`. Both the server's
reading of `build-info.json` (HealthController) and the runner's parsing
of the `register` payload (`RunnerChannel`) use it — checking
only the type (`is_binary`) would let an empty string, non-hex characters,
or 41 characters through. The dashboard (`protocol.ts`) and runner
(`build_info.ts`) independently duplicate the same regular expression
because they cross language boundaries, but the “same domain” agreement is
unified across all three languages.

`register`'s `build_revision` / `build_dirty` are valid only
when **both are omitted** (compatibility with pre-#218 runners) or **both are
present**; presenting only one rejects the entire register (same handling as a
type/domain violation — this rejection enforces structure, not the SHA value
itself).

### Dashboard: warn operators about both mismatch and unknown

Compare the connected runner's `build_revision` (through the register
payload) with the server's `build_revision` (from `GET /api/health`),
and warn not only on mismatch but also when **runner unknown / server unknown**
(`LaunchDialog` directly below host selection). This is observability
only; do not block startup.

**Round 2 expanded the state transitions (ふじ's rejection, MF-4).** Round 1
silently gave no warning for the two states “runner `build_revision` is
absent” and “server health fetch failed” — they were indistinguishable from a
match, contrary to #218's purpose of honestly exposing the absence of a signal.
Round 2 displays absent / runner unknown / server fetch failure / server unknown /
mismatch / dirty as separate messages, and warns only when it is **matching and
clean**.

**Round 3 found a gap on the dirty side (ふじ's rejection, MF-1).** Round 2's
dirty check looked only at runner `host.build_dirty` and did not pass
the server's own dirty
(`GET /api/health`'s `build_dirty`) to the dashboard. The
combination “server dirty, runner clean, matching revision” could therefore be
silent, contradicting the rule above. The dashboard receives server
`build_dirty` too and displays wording that distinguishes runner dirty
from server dirty.

**Round 3 also found a broken pair invariant on the dashboard side (ふじ's
rejection, MF-2).** The server rejects anything other than “both omitted or both
present”, while dashboard `parseHosts` copied `build_revision` and
`build_dirty` **independently** — leaving dirty by itself when revision was
out of range (or vice versa). A malformed revision with `dirty: false`
could be silent as “matching and clean” when it happened to match the server's
revision, a fail-open spoofing path. The dashboard narrows the pair as one unit
at its trust boundary and retains both only when both are valid.

Health is fetched not only once at mount but also when the channel (re)joins
(including reconnection after server redeploy) and immediately before opening
LaunchDialog (`cache: "no-store"`). Multiple fetch triggers can race
asynchronously, so a monotonically increasing generation counter prevents an
older response from rolling back state.

### Runner launch shim: forward `--version` before config checks

**Round 2 found a missed implementation (ふじ's rejection, MF-5):**
`runner/deploy/kaoiro-runner-launch.sh` did not forward any arguments to
the entry point unless the config existence check passed. Consequently,
`docs/specs/deployment.md`'s claim that `--version` can be
checked through the tarball distribution's launch shim was **actually false on
an unconfigured first-run host** — the hosts that most need to identify what
they were built as could not check it. The shim was fixed to forward
`--version` to the entry point **before** the config check, and tests
pin that the canonical forms of `cli.js --version` /
`VERSION` / `dist/build-info.json` agree.

### SHA mismatches remain observability only; do not reject

**Do not reject a git SHA mismatch in the runtime handshake.**
Docs-only commits, backports, and rolling windows can all legitimately have
different SHAs. Keep SHA as observability, and treat “same SHA” as a deploy
postcondition (even when an already-connected runner and server report different
SHAs, do not reject the communication itself).

If compatibility must be rejected, use a separate protocol compatibility epoch /
range or capabilities. Do not use ADR-0015's `version=0` warn-and-accept
as a substitute for the artifact SHA.

Rejecting `"unknown"` / dirty is outside the scope of this ADR / #218 —
separate introducing the identity from enforcement using it
([issue #220](https://github.com/sakuraiyuta/kaoiro/issues/220)). Mixing
enforcement into #218 risks preventing the server from starting in a dev
environment.

## Consequences

- The “cannot prove” section of the runbook (issue #217,
  `docs/specs/deployment.md` 4.5) was replaced with verification through
  a full-SHA health endpoint and the runner's register information.
- The VERSION file from
  `scripts/build-runner-tarball.sh` now uses a full SHA, and the source
  of dirty computation is unified to `dist/build-info.json` (the startup
  shim needs no change — `cli.ts` reads `dist/build-info.json`
  directly).
- Server deployment gains an explicit step to pass
  `KAOIRO_BUILD_REVISION` / `KAOIRO_BUILD_DIRTY`
  (`docs/specs/deployment.md` 4.3). Forgetting to pass them only becomes
  observable as `"unknown"` / `false`; the build itself does not
  fail.
- Enforcement of `unknown` / dirty (rejecting production builds) is
  intentionally outside this issue — it remains an open item owned by issue
  #220.
- Round 2 (ふじ's rejection) fixed the following: server identity moved from ENV
  to an image-baked file (MF-1); the degradation scope when dirty calculation
  fails (MF-2); repository-level unification of revision/dirty calculation
  (MF-2); value-domain validation unified across three languages (MF-3);
  dashboard warnings expanded from two silent states to six explicit states and
  health refetched on multiple triggers (MF-4); and the forwarding order of
  `--version` in the launch shim (MF-5).
- Round 3 (ふじ's rejection) fixed the following: server dirty was made an OCI
  label (`com.kaoiro.build-dirty`) and delivered to the dashboard
  (MF-1); the dashboard `parseHosts` revision/dirty pair invariant was
  repaired (MF-2, preserving the server rule of “both omitted or both present”
  at the dashboard trust boundary too); the value-domain validation bypass in
  `build-identity.mjs --format` (MF-3); value-domain validation for
  `built_at` (MF-4); and the terminology correction from “immutable” to
  “image-baked” (advisory 2).

## Alternatives Considered

- **Call `git rev-parse` at startup**: Rejected because both repo-direct
  operation and tarball distribution could report a value unrelated to the
  artifact running (see Decision).
- **Persist `KAOIRO_BUILD_REVISION` in `.env`**: Docker Compose's
  `.env` is a shared file used for both build-argument variable
  expansion and container-runtime environment variables; a value written there
  once may remain stale on the next build — there is a risk that `/api/health`
  reports an old value while the actually built SHA and the `.env` value
  differ. Pass `KAOIRO_BUILD_REVISION` as a one-shot environment variable
  for that build invocation, and do not include it in `.env.example`.
