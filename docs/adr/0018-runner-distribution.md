---
title: Distribution of wrapper/runner (OS-specific single binary, CLI only, Gitea release)
status: accepted
date: 2026-06-16
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [setup-wizards]
related_adrs: [17, 23, 24]
---

# ADR-0018 — Distribution of wrapper/runner

## Status

Accepted (start deferred until the main functions are in place)

## Context

The method for distributing and installing wrapper/runner on each host (including Linux/macOS/Windows and headless hosts) is undecided. Configuration generation already exists in [setup-wizards](../specs/setup-wizards.md) (provisional), but distribution (packaging) has not been specified. The ultimate goal, a “total resource-management solution,” requires it to run even on hosts with only a command-line interface.

## Decision

- The distribution form is a **single executable binary for each OS** (compiled with the runtime bundled, eliminating the Node prerequisite).
- **CLI only (no GUI)**. It must run on hosts with only a command-line interface and on headless hosts.
- Configuration generation is an extension of setup-wizards: (i) if no configuration exists, **automatically start the wizard on first launch**, and (ii) place the configuration in an **OS-specific user configuration directory** (Linux `~/.config`, macOS `~/Library/Application Support`, Windows `%APPDATA%`). **(i) has been withdrawn**—[setup-wizards](../specs/setup-wizards.md) (accepted 2026-07-25, issue #139) superseded it with “do not start automatically; the launch shim exits 78 and points to the wizard command.” An interactive prompt launched from a non-interactive session started by systemd / launchd would otherwise block indefinitely without a TTY. (ii) remains in effect.
- The distribution channel is **a Gitea release (binary assets) for the time being**, and GitHub Releases once the project is made public on GitHub.

**The start timing is after the main functions are in place** (low priority; deferred).

### Revision (2026-07-25)—Defer the single binary and ship a Node-dependent tarball first

By the maintainer’s decision, **single-binary compilation (`bun compile`) is withdrawn and deferred**; for now, distribute a **self-contained tarball that assumes only the Node runtime** (issue #70).

Reasons for the withdrawal:

- bun is in an unstable period immediately after a full rewrite from Zig to Rust (merged in 2026-05 / announced in 07)
- The known unresolved issue that native `.node` files from `sharp` cannot be embedded in `bun build --compile` (sharp#4283 / bun#15374)
- Because the wrapper starts the engine CLI as a child process through the Agent SDK, even a single binary would not remove the runtime prerequisite on the distribution host — **corrected by the measurement below**

**Correction based on measurement**: The engine CLI binaries are bundled by the SDK as platform-specific npm packages (`@anthropic-ai/claude-agent-sdk-<os>-<arch>` 245 MB / `@openai/codex-<os>-<arch>` 297 MB). Therefore, tarball distribution **does not require Claude Code / the codex CLI to be prepared separately on the destination host**. Conversely, because sharp, canvas, and both CLIs are all platform-specific optional dependencies, **an OS/arch-specific archive is mandatory**.

Revised decision:

- Build with [`scripts/build-runner-tarball.sh`](../../scripts/build-runner-tarball.sh) (package the output of `pnpm deploy --legacy` directly as tar.gz)
- Build for the **two architectures actually needed (`darwin-arm64` / `linux-x64`)**; do not build four architectures uniformly
- Cross-build by injecting pnpm’s `supportedArchitectures` only during the build (measured and confirmed that both can be generated from one darwin host)
- Installation must be no more than “extract → edit the configuration file → run one command.” Do not require `pnpm install` / build / workspace resolution on the destination host
- The launch shim, unit, and plist for daemonisation (#136) are **included in the distribution unchanged** (the shim resolves `../dist/cli.js` from its own location, with `deploy/` and `dist/` as siblings directly under the distribution)
- Automating asset uploads to a Gitea release is out of scope (#140)
- **Re-evaluate `bun compile` after the Rust version stabilises (target: 2027-01)**. The SDK provides an `extractFromBunfs` helper for Bun single-file executables, so resolving the sharp issue is a prerequisite

Archive sizes (measured, tar.gz): **256 MB for darwin-arm64 / 368 MB for linux-x64**. The Linux version is larger because it also includes the musl variant, but supports both glibc / musl (it was not possible to exclude the musl variant with `supportedArchitectures.libc`).

### Revision (2026-08-16)—Unify installation as immutable release + atomic switch

[issue #219](https://github.com/sakuraiyuta/kaoiro/issues/219).
Until this point, this ADR decided only how to **build** tarballs and did not decide their **post-installation form**. In that gap, an operational form that was documented nowhere had entered practice: **keeping a repository checkout as the live path and overwriting its running `dist` on every update** (the production host was actually running this way).

This is dangerous because **the runner resolves the on-disk artifact every time it spawns a wrapper**. `runner/src/spawn.ts`’s `resolveWrapperLaunch()` obtains the path with `require.resolve()`, and does so lazily per engine (codex is not resolved until the first codex spawn). Rebuilding a live checkout can make the old runner pick up the new wrapper, or make it pick up a module graph mixed between old and new versions. The `ConfigError` observed in [issue #209](https://github.com/sakuraiyuta/kaoiro/issues/209) is only one example; **a version check cannot save a partial module graph**. This had been avoided by relying on a person to follow the order “stop → build → start,” but one mistake in that order would reproduce it.

#### Decision

**The installation target is an immutable release directory, and the live path is only one symlink (`current`).**

```text
<install-root>/
  releases/<revision>[-dirty]/   # tarball を展開したもの。以後不変
  current  -> releases/<revision>
  previous -> releases/<revision>
```

`<install-root>` is Linux `${XDG_DATA_HOME:-~/.local/share}/kaoiro`, and macOS `~/Library/Application Support/kaoiro` (overridable with `KAOIRO_RUNNER_INSTALL_DIR`). On macOS it is the same directory as the config directory—Apple does not separate data / config. Entry names do not collide.

**Source origin and activation layout are separate axes**. Confusing them would keep the “run from the repo” form—an option that no longer exists—alive in the documentation.

| Axis | Possible values |
|---|---|
| **source origin** | Gitea release tarball / local repo build |
| **activation layout** | **the same for both**: `releases/<id>/` + `current` |

- Therefore, the form formerly called “repo-direct” is called the **local-build release profile**. The repo is the **build source**, not the live path. Because it converges on the **same installation form and same scripts** as a host receiving a tarball, there is only one execution path
- **Pointing `ExecStart` directly at a repo checkout is not recognised as a profile** (it can still be started manually as before during development)
- **Switch after stopping, using a temporary symlink + `rename(2)` atomically**. `mv` cannot be used—when the destination is a symlink to a directory, `mv` **follows it into the directory** (measured with GNU coreutils 9.4: `current` continued to point to the old release and a temporary symlink was left inside the old release). GNU `mv -T` is correct, but it is not available on BSD / macOS, so call `rename(2)` through node
- **Keep the immediately previous release as `previous`**. The default number of generations to retain is 3 (`--keep`). However, do not delete the releases pointed to by `current` / `previous` regardless of the generation count—for the lazy wrapper resolution described above, the active release continues to be read after startup
- **The launch shim only verifies; it does not build**. It checks the `MANIFEST.json` generated by the builder—the presence of `dist/` for the runner itself and for every `@kaoiro/*` package reached by following dependency declarations from the two wrappers. Only a repo-direct checkout without `VERSION` falls back to four sentinels (`dist/cli.js` / `dist/build-info.json` / `dist/cli.js` for the two wrappers). The discriminator is whether `VERSION` exists, not whether the manifest is readable
- **Install / switch independently re-derive the module graph and reject omissions from the manifest** (issue #219 もも review). The manifest cannot be its own witness. **The input to re-derivation is `package.json` in the same tree, so this is not tamper resistance**—it closes builder bugs and partial post-distribution damage, not an actor that rewrites the entire tree. Signatures / digests outside the tree are separate
- **Run updates in a transient *service* unit with `systemd-run --user --no-block`**. If an agent under the runner directly invokes the update script, it disappears when it stops the runner and the rest of the update does not run

#### What matters is the cgroup, not the process group

The default of `KillMode=control-group` in `systemd.kill(5)` is “all remaining processes in the control group of this unit will be killed on unit stop.” **Even if the caller leaves the process group, it is killed along with the runner if it remains in the runner service’s cgroup**. Becoming a transient *service* unit is what escapes this, and `systemd-run(1)` says it “will run in a clean and detached execution environment, with the service manager as its parent process.”

Therefore, the following three launch arguments are mandatory, and omitting any one is fatal:

- **Do not use `--scope`.** A transient scope is executed by systemd-run itself and “will thus inherit the execution environment of the caller”; it is also synchronous. That would return the update to the unit being stopped, and it cannot be combined with `--no-block`
- **Do not set `PartOf` / `BindsTo`.** They would propagate the runner’s stop through another path
- **Set `--no-block`.** Do not make startup wait for a unit whose first job is stopping the caller

Use an exclusive lock as well.

#### `--detach` does not report success

`--no-block` returns when the start request is “only verified and enqueued” (`systemd-run(1)`). **The update has not even started**, so the exit status of `--detach` says nothing about the result. Output is limited to the fact that it was enqueued, the unit name, and commands for checking the journal / status. The operator performs the final confirmation.

#### GC of interrupted staging

An install / build staging directory exceeds 1 GB per copy. Remnants of a run that died without reaching its EXIT trap (SIGKILL, power loss) contain only the dead pid in their name and will never be revisited. **Immediately after acquiring the exclusive lock and before creating its own staging directory, perform GC**—the lock makes “anything still present was abandoned” true. Use different prefixes for the lock directory (`.lock.*`) and staging (`.staging.*`) so that the GC glob does not include its own lock

**Do not adopt `ExecStartPre=pnpm build`.** It ties crash restarts and OS startup to the success of the compiler / node_modules / pnpm, keeps the service stopped throughout the build, and can leave a half-written `dist` on failure. A check that “`dist` is older than HEAD” also cannot represent the lockfile / tsconfig / dependencies / deleted files / dirty tree.

#### Release identity contract

The identity in [ADR-0053](0053-build-identity.md) is `revision` + `dirty`, and **`dirty` says that the contents are not determined by this SHA**. In other words, separate dirty builds of the same commit **have different contents while colliding on the same id**. Since `current` determines what the host is running, allowing this merely moves the question “what is actually running?” up one level.

| Target | Contract |
|---|---|
| **activation** (id that can become `current`) | **Only a clean 40-digit hex value**. `-dirty` / `unknown` are limited to a dev host that explicitly uses `--allow-dirty` |
| **reinstall of a clean release** | **Not replaceable**. Reinstall is a no-op because it is content-addressed. Provide no replacement flag |
| **reinstall of a dirty / unknown release** | Rejected by default. Replacement is allowed with `--allow-dirty`, but not while `current` / `previous` points to it |
| **rollback** | No gate. `previous` has already been activated once; rejecting it would only trap the host on a broken release |

Not providing a way to replace a clean release makes `releases/<clean-id>/` **actually immutable**, rather than immutable merely by convention. If corruption is suspected, delete it by hand—leaving a trace. Do not leave a path that silently overwrites it.

**Because the id becomes a path component, validating its value range is a security boundary.** `grep -q '^…$'` anchors by line and succeeds if any one line matches, so it **cannot validate a multi-line value**. Measurement (2026-08-16): a tarball whose VERSION was `../../pwned-marker\n<40 hex>` passed verification, wrote a release tree two levels above the install root, and exited 0. `$(cat FILE)` removes only the trailing newline, and because a newline is not a path separator, this does not prevent traversal. Validate by using the shell’s `case` glob to reject characters outside the id’s character set (including newline, `/`, and `.`).

#### Measurement of the premise (2026-08-16)

This design depends on “a running runner is unaffected by switching `current`.” Node realpaths module paths by default, so it should hold, but this was measured rather than asserted: a process launched through `current/deploy/` resolved its `import.meta.url` to `releases/<id>/dist/cli.js`, and **lazy `require.resolve` after switching `current` to another release still pointed inside the original release**.

The converse is the retention rule above—**pruning a running release breaks resolution for a codex spawn that has not happened yet**.

#### Scope of application (as of 2026-08-16)

**“Atomic switch is Linux-only” is incorrect**, so separate it by layer.

| Layer | Scope |
|---|---|
| release layout (`releases/<id>/` + `current` / `previous`) | **OS-common** |
| install / switch scripts and the atomicity of symlink + `rename(2)` | **OS-common contract**. Measured on Linux. **Not measured on macOS** |
| service-manager orchestration (stop → pointer swap → start, self-stop-safe updater) | **Linux / systemd only** |

The atomicity of `rename(2)` is a POSIX requirement, not Linux-specific. Avoiding `mv` was also for portability—GNU `mv -T` is unavailable on BSD / macOS. Therefore, the switch script is portable by design, but **operationally unverified on macOS**. launchd has no equivalent to `systemd-run` (it requires a substitute using `launchctl submit` / another LaunchAgent + `kickstart`), and there is no real machine available, so it cannot meet acceptance. macOS orchestration is split into a follow-up issue.

#### Node dependency introduced by the release verifier (2026-08-16)

Strict verification (install / switch) re-derives the closure through V8’s parser via `vm.SourceTextModule`. This follows the decision to stop reading JS without a parser, after hand-written lexical analysis produced the same class of defect four times (issue #219). This adds two bindings to Node on the distribution host.

| Binding | Details |
|---|---|
| experimental API | `vm.SourceTextModule` requires `--experimental-vm-modules`. Without the flag it is `undefined` (measured on node v24.3.0). This can change without notice on the Node side |
| version | The accompanying `--disable-warning` was added in Node >= 20.11 / 21.3. It always exists within `engines.node >= 22`, but older node versions fail while parsing the flags |

The flag is passed in exactly one place, `kaoiro_verify_release_tree` in `kaoiro-runner-common.sh`. The launch shim remains plain `node` and only checks for existence (`--require-manifest` is absent), so it does not reach this code. If the strict path is entered without the flag, the verifier exits 70 without skipping re-derivation—degrading it would restore the known fail-open behaviour of accepting an underspecified `MANIFEST.json` with exit 0.

The follow-up locations when `vm.SourceTextModule` becomes stable / changes are this one and `expectedClosure` in `runner/deploy/verify-release.mjs`.

#### Declare runtime references—do not detect them (2026-08-16)

The closure picks up only two kinds of edges, neither involving inference.

| Kind | Source |
|---|---|
| static import graph | V8’s `dependencySpecifiers` |
| paths assembled at runtime | Each package’s `kaoiro.runtimeAssets` in `package.json` |

An implementation that detected the latter from call-string forms was once written and withdrawn. Because a regular expression cannot resolve bindings, it read both `foo.require("./x.js")` (an unrelated method call) and code that defines and calls its own `class URL` inside a module as genuine edges, rejecting healthy releases with exit 70. After the third false positive of the same class, the mechanism was removed entirely. V8 does not expose scope information, and adding a parser that could provide it would add a dependency; therefore, stop guessing instead of making the guess more precise.

Example declaration (`wrapper/codex/package.json`):

```json
"kaoiro": { "runtimeAssets": ["dist/bridge.js"] }
```

There are two actual runtime references (as of 2026-08-16).

| Package | How the reference is written | Declaration |
|---|---|---|
| `@kaoiro/codex` | `new URL("../dist/bridge.js", import.meta.url)` | `dist/bridge.js` |
| `@kaoiro/claude-code` | `createRequire(import.meta.url).resolve("./probe.js")` | `dist/probe.js` |

**Boundary**: Runtime references without declarations are invisible to the verifier. A change that adds a runtime reference is one change through the point where the declaration is added. Literal-argument dynamic `import()` / `require()` are handled the same way.

Omissions are caught in CI by `runner/test/runtimeAssetDeclarations.test.ts`. This test uses the same textual heuristic that the verifier discarded—intentionally. The cost of a false positive is one red test and human judgement on the test side, whereas on the verifier side it would stop deployment of a healthy release altogether.

**This heuristic itself once missed a reference**. It initially looked for only the three forms `new URL(` / `import(` / `require(`; `createRequire(...).resolve(...)` passed through because the call string does not contain `require(`. As a result, the measured statement “there is only one runtime reference” was trusted as-is. In reality, `dist/probe.js` was undeclared, and strict verification passed with exit 0 when `probe.js` and its manifest entry were deleted together from a real release (found in review round 2). It now reads the binding name of `createRequire` from the file and scans for `.resolve(`; template arguments containing `${...}` are listed as “cannot be automatically determined” with supporting reasons (the number of exceptions is fixed, so adding one more in the same file makes the test fail). The lesson fits in one line—**the number counted by your scan pattern says nothing about what lies outside that pattern**.

The trust boundary is the same as the `dependencies` map and no more. Anyone who can rewrite `MANIFEST.json` can also rewrite this field. It closes builder bugs and partial damage, not tampering.

## Consequences

### Positive

- Smooth cross-OS installation. Suitable for headless operation. **“Without Node” expired in the 2026-07-25 revision**—once single-binary compilation was deferred and the Node-dependent tarball was prioritised, Node (>= 22) became required on the distribution host (the third point under Negative is authoritative). The release verifier (`verify-release.mjs`) from the 2026-08-16 revision also runs on node. This prerequisite remains until single-binary compilation resumes
- Distribution is complete on the self-hosted Gitea.

### Negative

- Requires selecting CI for OS-specific cross-builds and a single-binary compilation tool.
- The tarball (2026-07-25 revision) includes the engine binaries, making it 256–368 MB per architecture (tar.gz). Judged acceptable as self-hosted Gitea release assets.
- Node (>= 22) is required on the distribution host. This prerequisite remains until single-binary compilation.
- Strict install / switch verification depends on the experimental API (`vm.SourceTextModule` + `--experimental-vm-modules`). See “Node dependency introduced by the release verifier” above for details and follow-up locations.

### Neutral

- The distribution unit depends on the package split in [ADR-0017](0017-wrapper-multientity-packages.md). The runner daemon specification is established in [ADR-0023](0023-host-runner-architecture.md) (supervisor-only / TS/Node / `kaoiro-runner`) and is directly connected to resume in [ADR-0014](0014-session-resume-and-restore.md).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| npm/pnpm package (`npm i -g`) | Requires Node on each host. Disadvantageous for a minimal headless configuration |
| Container distribution | The runner needs access to the host’s `~/.claude`, local processes, and cwd, so this is unsuitable |
| GUI installer / GUI configuration | Cannot run on hosts with only a command-line interface |
| Publish to public npm | A Gitea release is sufficient until the project is public on GitHub |

## Related

- spec: [setup-wizards](../specs/setup-wizards.md).
- Related ADRs: [0017](0017-wrapper-multientity-packages.md), [0014](0014-session-resume-and-restore.md).
- Unresolved (as of 2026-07-25): selection of a single-binary compilation tool awaits re-evaluation of `bun compile` (after the Rust version stabilises, target 2027-01). Whether runner/wrapper should be one binary is likewise on hold because it is a single-binary premise; with a tarball, both are in one archive and the practical issue is resolved. Cross-building is resolved with pnpm’s `supportedArchitectures` (measured that linux-x64 can be generated from a darwin host).
- Origin: my-idea-brief (scratch note “distribution of wrapper/runner”).
