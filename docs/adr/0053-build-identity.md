---
title: build identity and separation
status: accepted
date: 2026-08-12
opened: 2026-08-12
supersedes: []
superseded_by: null
related_specs: [deployment, protocol]
related_adrs: [15, 18, 23]
---

# ADR 3 —par build identity and separation

## Status

Accepted

## Context

There was no means to say which commit is from factfact in operation
([issue #218](https://github.com/sakuraiyuta/kaoiro/issues/218))。
`runner`
`--version`  , `server/Dockerfile`, OCI label  ,
build revision in register payload — all missing.

The mtime of the file is used instead, but this is not established. `dist`
directory mtime does not update if no files are added or deleted
"3 Package remains 10 days ago"
[issue #217](https://github.com/sakuraiyuta/kaoiro/issues/217)
the runbook.

`scripts/build-runner-tarball.sh` is git short SHA
I wrote the dirty mark to `VERSION`, but the unification of full SHA and dirty definition is
required.

[ADR-0015](0015-protocol-version-stamping.md)
wire protocol compatibility, not the identity of thefactfact. Home
Both are a separate axis, and when conf , "docs-only commit causes compatibility errors"
It becomes a wrong design.

## Decision

`revision` / `dirty`
Add `built_at`) only to  . `revision` and `dirty`
identity。

**`built_at` is a diagnostic-only field on the Japanese term side and on the Japanese term side
Issue #218 round 2 advisory 2, Home
`BuildInfo`(TS type,
`runner/src/build_info.ts`) means the identity of thevision side (revision/dirty
the two fields only) indicate that they are separate. 
The implementation can be erroneous as "built at is required for Japanese term". `built_at`
Don’t use it anywhere else — “w  commit comes from?”
embody the central distinction of the book ADR that is only identity
Because it is a field, if you use it in comparison, this ADR contradicts itself.

**`built_at` is also subject to value verification (issue #218 round 3, Home revert MF-4).**
diagnostic Because it is only available, it is not possible to allow any string —
`generate-build-info.mjs` canonical
ISO-8601 format, or only `UNKNOWN_BUILD_INFO` literal `"unknown"`


### Dirty definition (single location)

`git status --porcelain`**both tracked and untracked**
`git diff --quiet` does not see untracked,
issue #217, the untracked file is an existing dirty
There is an actual example.

**Round 2 Judgment (Home Reversing and MF-2):** `git status --porcelain`
(rev-parse is success but the status is failure),
**degrade the entire identity to `unknown`**— The revision remains true
`dirty: false` "Undeterminable to false"
"degrade" means "I don't know it is okay" and "I don't know"
different from "unknown degrade". tri-state
not missing/true/false
absent/unknown/dirty-unknown/dirty/clean-mismatch/clean-match
issue #220 enforcement To make things that can only be complex.
degrade Leaves to the log for the initial diagnosis (not unknown).

This calculation is**repo-level `scripts/build-identity.mjs` only one place**Home
Ground 1 implements only `generate-build-info.mjs` on the   side
but the   build args calculation was not here —
round 2 completed this single. `runner/scripts/generate-build-info.mjs`
import this and write `dist/build-info.json`. server build procedure
(`docs/specs/deployment.md` 4.3) also calls the same script
`KAOIRO_BUILD_REVISION` / `KAOIRO_BUILD_DIRTY`
`scripts/build-runner-tarball.sh` does not call `git diff --quiet`,
Read `generate-build-info.mjs`
Assembling `VERSION` (`--format` mode) — the definition is
Structurally close different risks.

**round 3 arbitration (Home revert, MF-3): `--format` also validates the same arbitration
Comment round 2 `--format` just read and format files
`revision`/`dirty` has not been verified —
Broken like `{"revision":"not-a-sha","dirty":"false"}`
If you pass build-info.json, the string `"false"` is
Dirty treated `not-a-sha-dirty` to be output flatly (CO
`loadBuildInfo()` degrades the same file to `unknown`
`--format` non-consistent). fail-loud
Home**degrade to the same `unknown` as  **that — to the same file
It is not possible to have a different behavior for each reader. degrade
to stderr.

### : build`dist`Burn (not calling git on startup)

git is distributed as tarball without git
([ADR-0018](0018-)-)bution.md)))   after distribution is launched
`git rev-parse` repo-direct
`dist` is normally going to `HEAD` with old commit —
If you report `git rev-parse HEAD` at startup, factfact that is actually working
The value that is unrelated to * is named as build revision. Issue #217
the runbook pointed out that mtime is based on the success.
The same hole in #218
Repro .

**build time**`pnpm -C runner build`
only `generate-build-info.mjs` is execution
`dist/build-info.json` `cli.ts`
You can read this file when you start, and you can't call git. repo-direct
Both execution and tarball distribution are the same route. git cannot be used/repos y
fail-soft to `revision: "unknown"` if it is outside — do not stop starting.

### server: burn to image-baked file via build arg

`.dockerignore` ex s `.git` from the build context.
The build reads it So in Dockerfile
`git rev-parse` is not possible and the `KAOIRO_BUILD_REVISION`/
`KAOIRO_BUILD_DIRTY` is only available as build arg
Pass `scripts/build-identity.mjs` output to `docker compose build` —
`docs/specs/deployment.md` 4.3)。

**round 1 is the same as `ARG` → `ENV` → `LABEL`
pattern, but this was judged to be incorrect in round 2 (Home revert,
MF-1)。**`ENV`**`docker run -e`
`docker-compose.yaml` `env_file: .env` can be overwritten — change the name
"Reverted the same mistake as rejected in  server to the server side"
exe: The identity that should be determined at build is to be another value when execution
It was possible to change. `KAOIRO_PLAIN_HTTP` ARG/ENV pattern
However, the reason not to attack (existing judgment from round 1) was correct,
"The structure that can be written" was left only with "`.env`".

Final stage from `ARG`**image-baked file**
(`/app/build-info.json`) and OCI label are generated from this ARG
(Because it is generated from the same ARG, both are always matched). `GET /api/health`
`KaoiroServerWeb.HealthController` is not `System.get_env`
**File**`RELEASE_ROOT` automatically export when Mix release starts
Read from the environment variable (only pointing to the location of the file instead of the value itself).

**(issue #218 round 3 advisory 2, Home):**
"image-baked" instead of "immutable". `/app` owns `nobody`,
`build-info.json` `chown nobody:root` — to process during the execution
There is no tamper-resistance.
Only "independence from container-RUN-time env" is guaranteed.

`dirty` is also OCI label (`com.kaoiro.build-dirty` — `dirty` is
project-custom
label). round 2 burned to `build-info.json` but labeled
Forgotten and confirm the provenance via `docker inspect` (dep ment.md 4.5)
I couldn't see dirty (issue #218 round 3 MF-1).

`mix phx.server` local startup (when developing without Docker)
`RELEASE_ROOT` returns `"unknown"` because it is not set. git fallback
Unable — the same reason as dev (dev checkout state and devfact invoke
is unrelated).**`"unknown"`**and this aJapanese termmetry
Thanks**`"unknown"`**can be determined.

### Validation of value range (round 2, Home MF-3)

`revision` is a 40-digit Japanese term
git SHA is a value area that is only positive and is one place in `KaoiroServer.BuildIdentity`
Only implement. server own `build-info.json` read(HealthController)
`register` payload analysis (`RunnerChannel`)
Use — only the type (`is_binary`) is empty, non-sh , and 41 digits.
dashboard side(`protocol.ts`)・  side
(`build_info.ts`) reproduces the same regular expression independently to cross the language boundaries.
The arrangement of "the same value area" is unified in 3 languages.

`register` `build_revision` / `build_dirty` is "both" (pre-#218)
only one of the   or both presentations, and only one
The presentation rejects the entire register (the same as the type collapse and the value range) — this
rejection is not const tion to the SHA SHA itself).

### dashboard: Warning both mismatch and unknown to operator

CO `build_revision` (via register payload)
Compare `build_revision` (`GET /api/health`) and not only when unmatched
**side unknown / server side unknown**Warning
`LaunchDialog` observability only — block startup
not.

**extended state transition in round 2 (Home revert, MF-4).**round 1
CO `build_revision` is absent and  health-side health
2state of failure**no warning**— this is "matched"
"signal  " will show itself honestly to the operator
#218 round 2 in absent /   unknown /
server failure / server unknown / mismatch / dirty
display and**Only when matching and clean**No warning.

**Round 3 found a dirty side hole (Home revert and MF-1).** round 2
The dirty deter  is only seen in `host.build_dirty` of  , and  itself
Dirty(`GET /api/health` `build_dirty`)
Comment " clean is dirty,vision is clean and revision is matched"
"Unwarning only when matching and clean"
contradicted. dashboard also receives the `build_dirty` of the server,
warn of dirty and server dirty.

**round 3 dashboard side pair invariant also found (Home)
MF-2). ** server rejects other than both omitted or presented
dashboard `parseHosts` `build_revision` / `build_dirty`
**Independent**copy — the revision remains alone even outside the value range
(or vice versa) `dirty: false`
In the situation that matches the server's revision, "match and clean"
Fail-open dashboard Home trust boundary
pair as one unit and leave both valid.

health is not only once at mount, but also channel (re)join( health
re-acquisition just before launching redep )
(`cache: "no-store"`) Because multiple acquisition triggers can compete asynchronously,
A single-tuning generation counter prevents rewinding by old responses.

### launch shim:`--version`forward before config check

**MF-5:**
`runner/deploy/kaoiro-runner-launch.sh` checks the presence of config
Since it was a structure that does not transfer all arguments to entry point,
`docs/specs/deployment.md` 'tarball distribution launch via shim
`--version`**Indefinite hosts are actually lying**Comment
— config The more hosts in config, the more “w  is this host built?”
I couldn't confirm that it was a local surface I want to check. shim `--version`
config check**Home**to entry point.
`cli.js --version` / `VERSION`
pin on test that canonical form matches.

### SHA unmatched and rejected

**Reject git SHA in runtime handshake.**
docs-only commit,backport,rolling window
{{ data.filename }} SHA is observability and the same SHA is deploy
Handle as postcondition (already connected SHA and server different SHA
the communication itself is not denied).

If you are required to play compatibility, you can use protocol compatibility epoch / range
have different capabilities. ADR-0015 `version=0` warn-and-accept
SHAfact SHA

`"unknown"` / Dirty   enforcement to the scope of this ADR / #218
not included — the introduction of identity and its enforcement separate
([issue #220](https://github.com/sakuraiyuta/kaoiro/issues/220)
scope). When you mix enforcement to #218, the server is in the dev environment
Risks the risk of being unable to start.

## Consequences

- runbook (issue #217, `docs/specs/deployment.md` 4.5)
SHA Home register
subst ted to the confirmation.
- The VERSION file of `scripts/build-runner-tarball.sh` is full SHA
Dirty Determination Calculator is a single `dist/build-info.json`
No change — `cli.ts` reads `dist/build-info.json` directly.
- server deploy `KAOIRO_BUILD_REVISION` / `KAOIRO_BUILD_DIRTY`
Increased number of explicitly passed (`docs/specs/deployment.md` 4.3). Forgotten
`"unknown"` / `false` only becomes observable, the build itself is
No failure.
- `unknown` / dirty enforcement
Intentionally not included in this issue — remain as the responsibility of another issue (#220)
Not solved.
- round 2 (Home revert) returns the following: server identity from ENV
image inside image-baked file to (MF-1), degrade range at dirty judgment failure
(MF-2), repo-level of revision/dirty calculation, value domain
Validation of 3 languages unified (MF-3), Dashboard warning state 2 state noun silent
from 6 state to explicit display and re health health with multiple triggers (MF-4),
launch shim `--version` transfer order (MF-5).
- round 3 (Home revert): OCI label
(`com.kaoiro.build-dirty`) to reach dashboard (MF-1),
dashboard `parseHosts`'s revision/dirty pair invariant
dashboard trust boundary
MF-3
`built_at` MF-4, immutable → image-baked
Terms correction (advisory 2).

## Alternatives Considered

- **`git rev-parse`**: repo-direct
Rejected because distribution can report "unrelated value with factfact"
(see Decision).
- **Persistent `KAOIRO_BUILD_REVISION` to `.env`**docker-compose
`.env` is used for both the variable deployment of the build argument and env when the container execution
It is a shared file, and the value that I wrote at once remains old in the next build
null — `/api/health` in the state where SHA and `.env` were actually built
returns the risk of reporting older values. `KAOIRO_BUILD_REVISION`
It is one-time value passed as an environment variable of execution, and `.env.example`
Not available.
