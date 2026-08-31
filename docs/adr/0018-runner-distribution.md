---
title: Distribution of wrapper/OS (only single binary CLI and   release)
status: accepted
date: 2026-06-16
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [setup-wizards]
related_adrs: [17, 23, 24]
---

# ADR-0018 — Distribution of wrapper/ 

## Status

Accepted

## Context

Distribution of wrapper/Host to each host (including Linux/macOS/Windows and headless)
Unsecided approach to install. [setup-wizards](../specs/setup-wizards.md)
(provisional) already exists, but the distribution (packaging) is not specified. Final goal
In "Resource Management Total Solution", there is a need to move even on hosts of CUI only.

## Decision

- Distribution form**OS Separate single execution binary**(compile with runtime, Node premise)
).
- **CLI only (GUI disabled)**Home CUI and headless hosts.
- setuprate setup-wizards extension: (i) If you don't have a configuration,** start the wizard
Auto start**,(ii) set**OS separate user configuration directory** (Linux `~/.config`,
Added to macOS `~/Library/Application Support` and Windows `%APPDATA%`.
  **(i) removed** — [setup-wizards](../specs/setup-wizards.md)(2026-07-25
"Do not auto-start and start sim starts with exit 78" in
Override the wizard command. systemd / launchd
If the dialogue prompt rises in a given non-interactive session, the TTY will not be responded
to stop. (ii)
- Distribution channels**release (binary assets)**GitHub
  GitHub releases。

**The start timing is the main function**(low priority)

### Revised (2026 -25)—Precedent Node Premise tarball

By master judgement**single binary (bun compile)**
**Node tarball**Issue #70

With al Base:

- Fixed anxious time when bun rewrites Zig → Rust (published 2026-05 merge / 07)
- Known that `sharp` native `.node` cannot be embedded in `bun build --compile`
Unsolved problem (sha42#4283 / bun#15374)
- wrapper starts the engine CLI via the Agent SDK.
Even in binary, the runtime premise of the destination does not disappear —**However, the following survey is corrected.**

**Correction by actual measurement**: Engine CLI entities with platformpm package by platform
`@anthropic-ai/claude-agent-sdk-<os>-<arch>` 245 MB /
`@openai/codex-<os>-<arch>` 297 MB). For tarball distribution **host to distribute
Claude Code / codex CLI  
**OS/arch because all canvas and both CLIs are optional dependent on platform
A separate archive is required.

Revised decisions:

- [`scripts/build-runner-tarball.sh`](../../scripts/build- -tarball.sh)
(`pnpm deploy --legacy`)
- For actual demand**2 arch(`darwin-arm64` / `linux-x64`)**Home 4 
Don’t make it
- Cross-build only injects `supportedArchitectures` of pnpm
(check that you can generate both from one darwin host)
- The installation is "decompression → Edit configuration file → One command execution". Contact Us
`pnpm install` / build / workspace
- Residentification (#136) start Sim Unit/plist**Unmodified distribution**(Shim)
`deploy/` and `dist/` solve the `../dist/cli.js` from your location
Become a brother)
- Automate asset upload to   release (#140)
- **`bun compile` is re-evaluated after stable Rust version (  2027-01)**SDK
`extractFromBunfs` helper for Bun single-file executable
so theContact side solution is prerequisite

tar.gz:**darwin-arm64 256 MB / linux-x64 368 MB**。
The mus version also includes musl variants, so instead of glibc / musl
(`supportedArchitectures.libc` could notType musl variants).

### Revised (202616)16)—Unify the installation form to immutable release +  ic switch

[issue #219](https://github.com/sakuraiyuta/kaoiro/issues/219)。
tarball**rate****After installation**Home
Not decided. The blank is not written anywhere in the document.
Include — resident **repos y checkout with live path,
Overwrite `dist` in operation every update
I was moving in this way).

This is dangerous for on-disk whenever **wrapper spawns wrapper
to solve factfact. `runner/src/spawn.ts`
`resolveWrapperLaunch()` pulls the path with `require.resolve()` and
lazy for each engine.
If you build the checkout in operation, the old wrapper grabs the new wrapper,
or grab the new and old mixed module graph between packages.
[issue #209](https://github.com/sakuraiyuta/kaoiro/issues/209)
`ConfigError` is just an example, if you add **version check
partial module graph "Stop → Build → Start"
It was avoided by observing it, but it will be recurred once.

#### 

**The directory is immutable and live path is livelink.
Only 1 (`current`). Home

```text
<install-root>/
  releases/<revision>[-dirty]/   # tarball Expanded.Recent Posts
  current  -> releases/<revision>
  previous -> releases/<revision>
```

`<install-root>` is Linux `${XDG_DATA_HOME:-~/.local/share}/kaoiro`,
macOS `~/Library/Application Support/kaoiro`(`KAOIRO_RUNNER_INSTALL_DIR`
overwrite). macOS is the same directory as config dir — Apple
data / config entry name does not collide.

**source origin and activation layout**Home confusing
"The form of repo works", the document continues to grow the other nonexistent option


||Amount|
|---|---|
| **source origin** |release tarball / local repo build|
| **activation layout** | **Both** `releases/<id>/` + `current`Only one|

- Therefore, the form that was called "repo-direct" is
  **local-build release profile**Contact Us repo**build**
live path. tarball Same as distribution host
Only one execution path to converge in script**
- **The form that directs repo checkout to `ExecStart` is not allowed as a profile**
(It can be used as usual when it is started by hand at development)
- **After the switch is stopped,  ic is performed with linklink + `rename(2)`.**Home `mv`
unusable — `mv` follows it
GNU coreutils 9.4
link remains in the old release. GNU `mv -T` is correct
call `rename(2)` via node
- **Keep the previous release as `previous`**Home Default of retention generations 3
(`--keep`) `current` / `previous` refers to release to the number of generations
Don’t delete it — because of the lazy wrapper solution above, running release is
Continue reading long after startup
- **The startup sim does not build only verify**Home The test object is generated by builder
`MANIFEST.json` — wrapper's own `dist/` and wrapper's two dependencies
`@kaoiro/*` `dist/` — the presence of all packages.
sentinel only with repo-direct checkout without `VERSION`
4 (`dist/cli.js` / `dist/build-info.json` / 2 wrappers)
`dist/cli.js`) The discriminator is with or without `VERSION` and manifest
Not readable
- **install/switch rederives the module graph independently and takes the manifest
refusal** (issue #219 Home review). manifest cannot be your witness
Home **Re-derive input is `package.json` in the same tree, so this is
Not resistant** — closed builder bugs and partial corruption after distribution,tree
It is not a defense to the uterus that is rewriting the whole. signature / tree outer digest is separate
*service* unit
。   If the agent under the   is tapping the update script directly,  
When I stopped, I disappeared and I can't continue

#### not process group

`systemd.kill(5)` defaults to `KillMode=control-group` — "all remaining
processes in the control group of this unit will be killed on unit stop」。
** Even if you get out of the caller process group, leave it in the cgroup of the service service
Dying with the road if you are. transient *service* unit
`systemd-run(1)` will run in a clean and deta  execution environment,
"with the service manager"

Therefore, the following three are required for the startup argument, and both are deadly:

- **`--scope`**transient scope execution systemd-run itself
“We will succeed the execution environment of the caller”
become hronous execution. `--no-block`
Not available
- **`PartOf` / `BindsTo`**Stop   isJapanese termagated in another route
- **`--no-block`**The first work is the caller stop
Don't wait to start

Use exclusive lock.

#### `--detach`does not report success

`--no-block` when start request is "only verified and enqueued"
return (`systemd-run(1)`).**Not started**`--detach`
The exit status does not tell anything about the result. "enqueue"
only for the check command of the unit name and journal / status. Final confirmation is the operator
Comment

#### Suspendedgingging GC

More than 1 GB per install / buildgingging directory. EXIT
De s of dead run (SIGKILL, power off) without reaching  , name dead pid
No one revisits. ** Make your owngingging only if you have obtained an exclusive lock
prev GC** — true that lock is still abandoned. Lock
directory (`.lock.*`) andgingging (`.staging.*`) separate prefix and GC
Make sure that the glob doesn't remove your lock

**`ExecStartPre=pnpm build` does not adopt.**Start crash or OS
tied to compiler / node modules / pnpm, stops during build,
You may leave a mid-end `dist` when failure. `dist` is older than HEAD
lockfile / tsconfig / dependency / deleted files / dirty tree
Cannot be expressed.

#### release identity

[ADR0053] (0053-build-identity.md) identity is `revision` + `dirty`
HOME**`dirty` says, "This SHA does not have a medium."**Home In other words
dirty build**different content while id crashes**。
`current` is the name of determining what hosts are doing, so you can forgive it
The question of “What is actually doing?” is to come back to the top.

|||
|---|---|
| **activation** (`current`id)| **Clean 40 digits   only**。`-dirty` / `unknown`Home`--allow-dirty`to the dev host|
| **Clean release** | **No replacement**Home reinstall is no-op because content-addressed. No flags to replace|
| **Dirty / Unknown Re install** |Deny by default.`--allow-dirty`can be replaced. However,`current` / `previous`Cannot be pointed|
| **rollback** |Don't use gate.`previous`is   once, and the rejection only tied the host to a broken release|

`releases/<clean-id>/`
No change as a custom**Irregular**Contact Us If you suspect the damage, you can delete it by hand —
A trace remains. Never leave a route to overwrite silently.

**Since id is a path component, the value boundary is a security boundary.**
`grep -q '^…$'` anchors each line, and if any one line matches,
**Cannot verify multiple lines**Home Survey (2026 16): VERSION
`../../pwned-marker\n<40 hex>` tarball is validated and is installed root
2 Write release tree on the hierarchy and exit 0. `$(cat FILE)`
The line breaks, and the line breaks are not path .
The validation is the `case` glob of shell, and the id is not set (including new lines, `/`, `.`).


#### Prerequisite Survey(2026 16)

This design is dependent on "unable Design is not switched to `current`".
Node is established by default because module path is realpath, but it is not determined:
`import.meta.url` of the process launched via `current/deploy/`
`releases/<id>/dist/cli.js` has been resolved and **`current` has been switched to another release
The lazy `require.resolve` is also pointed to the original release.

back is the above-mentioned retention rule — if you prune the running release
** the codex spawn solution is broken.

#### Outside Directors (As of 20261616)

**"icic switch is Linux only" error**So, cut by layer.

|||
|---|---|
| release layout (`releases/<id>/` + `current` / `previous`) | **OS Common** |
|install / switch script and Splink +`rename(2)`atomicity| **OS Common Contract**Home Linux**macOS** |
| service-manager orchestration (stop → pointer swap → start、self-stop-safe updater) | **Linux / systemd** |

`rename(2)` atomicity is a POSIX request and is not Linux-specific.
`mv` is not in BSD/macOS.
so switch script is portable, but on macOS
unverified launchd has no `systemd-run` equivalent
(`launchctl submit` / another LaunchAgent + `kickstart` is required),
It is not possible to meet acceptance because there is no actual machine. macOS version orchestration continues
Cut to issue.

#### release verifier brings Node dependency(2026 16)

closure rederive for strict validation (install/switch)
`vm.SourceTextModule` Hand-written phrase analysis 4 times
By determining itself to read JS without parser
(issue #219) There are two bindings in the Node of the distributed host.

|||
|---|---|
| experimental API | `vm.SourceTextModule`Home`--experimental-vm-modules`without flags`undefined`(in node v24.3.0). Node can change without notice|
|Version|Contact Us`--disable-warning`is added in Node >= 20.11 / 21.3.`engines.node >= 22`always exists, but older nodes fall at the time of flag interpretation|

`kaoiro-runner-common.sh`
`kaoiro_verify_release_tree` Only one place. `node`
However, only existence confirmation (without `--require-manifest`), so this code is reached
not. If you enter a strict route while flagging, verifier will rederive
drops in exit 70 without skipping — if you want to shrink, you can use the IFEST.json
return to known fail-open.

If `vm.SourceTextModule` is stable / modified, this 1
`expectedClosure`

#### Declaration of execution reference — notJapanese term(2026 16)

The edges that the closure picks up are only two lines, both of which do not contain guesses.

||Home|
|---|---|
|Static import graph|V8`dependencySpecifiers` |
|Paths assembled during execution|Package`package.json`Home`kaoiro.runtimeAssets` |

An implementation that detects the latter from the call string was written and withdrawn. Regular expression
`foo.require("./x.js")`
and the code that is called with the `class URL` in the module, both are real
deny the sound release with exit 70. Identification of the same class 3 Examples
to remove the mechanism. V8 does not publish scope information, and it knows parser
Because dependencies are required to be put, you should not make a guess rather than making a guess.

Example declaration (`wrapper/codex/package.json`):

```json
"kaoiro": { "runtimeAssets": ["dist/bridge.js"] }
```

2 cases (as of 20261616)

|Package|How to write a reference||
|---|---|---|
| `@kaoiro/codex` | `new URL("../dist/bridge.js", import.meta.url)` | `dist/bridge.js` |
| `@kaoiro/claude-code` | `createRequire(import.meta.url).resolve("./probe.js")` | `dist/probe.js` |

**Boundary**: See verifier when execution without declaration. executioning execution
The change is one change to the extent that the declaration is sufficient. Dynamic literal arguments
`import()` / `require()`

`runner/test/runtimeAssetDeclarations.test.ts` drops with CI.
This test uses the same textual heuristic as the verifier was thrown away — intentionally
Comment The cost of erroneous detection is done with one red on the test side,
The whole deployment of the sound release is stopped on verifier side.

**This heuristic itself is taking it once**Home `new URL(` /
`import(` / `require(`
the call string does not contain `require(`. Result
"When execution refers only one", I believed it. In fact
`probe.js` and manifest entry
If you delete it at the same time, the strict validation passed with exit 0 (reviewed in round 2).
`createRequire`
The template arguments, including `${...}`, are grounded as "unable to automatically determine"
Enumerate an exception (the exception is fixed in the number of cases, so if one is found in the same file,
test falls). Lessons can be written in one line — **Number of cases counted in your scanning pattern,
Don’t say anything outside that pattern.

The trust boundary is the same as `dependencies` map, not more. IFEST.json
This field is also rewritten by the rewritten person. Close  builder bug
partial damage and not alteration.

## Consequences

### Positive

- Smooth cross-OS deployment. Fits headless operation.
  **"Node" expires in 2026 -25 revision**— postponement of single binaryization
Node (>= 22) becomes required when Node assumes tarball
(Negative) 2026 16 ver release verifier
(`verify-release.mjs`) until single binary is resumed,
This premise remains
- Completed distribution with self-host (Host).

### Negative

- Select CI and single binary tool for cross-build by OS.
- tarball (2026 -25 revision) contains the engine CLI entity
256-368 MB (tar.gz). Self-hosted  's release assets are determined to be acceptable.
- Node(>= 22) is required. This premise remains until single binaryization.
- install / switch's strict validation
(`vm.SourceTextModule` + `--experimental-vm-modules`)
"Node dependencies brought by Verifier" above.

### Neutral

- Distribution unit is divided into [ADR-0017] (0017-wrapper-multientity-packages.md) package
dependency.   resident daemon specifications
[ADR-0023](0023-host-host-architecture.md)
[ADR-0014](0014-session-resume-and-restore.md)
Contact resume

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|npm/pnpm Package`npm i -g`) |Node premises for each host. Disadvantages for headless minimum configuration|
|Container Distribution|host`~/.claude`・Unsuitable for accessing local process/cwd|
|GUI Installer / GUI Settings|Cannot run with CUI only host|
|Publish pm to publish|GitHub release|

## Related

- spec: [setup-wizards](../specs/setup-wizards.md)。
-wrapper ADR: [0017] (0017-wrapper-multientity-packages.md),
  [0014](0014-session-resume-and-restore.md)。
- Unresolved (as of 2026 -25): Re-evaluation of single binary tool
Waiting (R  version stable, approx. 2027-01).  /wrapper to 1 binary
single binary prerequisite, so hold — both in one archive
In order to enter, it is solved. `supportedArchitectures` for pnpm
resolved with darwin hosts to generate dar-x64.
- Origin: my-idea-efef
