# Launch delivery configuration evidence — 2026-10-10

Issue [#562](https://github.com/sakuraiyuta/kaoiro/issues/562), including the final C2/V7 producer-to-client integration.
Measured source and verifier revision: `8f79e01c6cef891f4ff4921b4e64a606f77a44b9`. Base: `c0684d8c6d5b1e44de2d6f9cc8e8870999d74c55` (the final C2 branch); the director will transplant onto develop after patch-id comparison. The accompanying [JSON record](2026-10-10-launch-delivery.json) binds commands, exit codes, local logs and SHA-256 hashes to this revision. This evidence-only commit does not change measured implementation or tests. Independent implementation review is pending; no release activation was performed.

## Final gates

Commands run inside their respective roots with `LANG=C.UTF-8 LC_ALL=C.UTF-8`, asdf shims on PATH, and `MIX_ENV=test` for Elixir. Dashboard dependencies were installed separately before its checks. `setsid -w` retains the child exit code. All rows below completed with exit 0.

| Gate | Command | Observed result |
|---|---|---|
| Wrapper | `pnpm test --maxWorkers=2 --minWorkers=1` | 3,871 passed, 7 skipped; 206 passed files, 2 skipped files |
| Runner | `pnpm test --maxWorkers=4 --minWorkers=1` | 1,137 passed; 57 files |
| Server | `CI=true mix precommit --seed 182700` | 2,147 passed, 1 excluded |
| Dashboard | `pnpm test` | 1,524 passed; 94 files |
| Dashboard | `pnpm check` | 0 errors, 0 warnings |
| Dashboard | `pnpm build` | one successful build; existing large-chunk warning |
| C2 browser | `pnpm exec playwright test --config playwright.delivery.config.ts` | 16 passed |
| C3/V7 browser | `pnpm exec playwright test --config playwright.delivery-integration.config.ts` | 3 passed; embedded real-server integration 3 passed |
| Workspace | `pnpm -r typecheck` | 7 packages |
| Release | `./scripts/build-runner-tarball.sh --out <owned scratch>` | 6 build scripts (5 wrappers and runner), one archive, 169 manifest entries |

Protocol has a typecheck script, not a build script. The seven wrapper skips are opt-in native/live delivery suites (Claude 4; Antigravity 3); they do not establish native model delivery. Both fixture consumers assert **5 valid / 15 invalid** cases (the common-suite log also prints these counts) from `protocol/fixtures/launch-delivery-policy.json`. Protocol-only and dashboard-only enum additions failed independently in their existing typecheck/check commands; fixture removal failed rather than skipped.

## Scope of integration

The C3/V7 tests build real runner register payloads, pass them through real Phoenix channel handlers, serialize the operator-visible hosts, and feed them through the built public dashboard client/decoder/UI. Three browser cases cover enabled metadata with a false default, a false ceiling, and metadata omitted for excessive overrides. The real-server tests also cover explicit policy priority, new-row defaults, and preservation of an existing row. This is a local integration, not a production network deployment or a native model turn. The explicit server test is `server/test/integration/delivery_launch_acceptance.exs`; it is intentionally invoked by the integration command rather than automatically counted in the ordinary server suite.

Default production composition tests execute built runner/Claude/Codex entrypoints against owned local WebSockets. They observe startup validation and wrapper join before releasing `persona_prompt`, so native engines are not started. Eight invalid config shapes are exercised through that startup path. Snapshot tests cover environment capture, delayed refresh, staged reload publication, and rollback after publication failure.

## Size measurements

These values come from the final real-server integration log (`:erlang.external_size/1`), not a handwritten model of the server representation.

| Case | JSON UTF-8 bytes | Erlang external bytes | external / JSON |
|---|---|---|---|
| actual | 4104 | 4836 | 1.178363 |
| rawMaximum | 24953 | 28393 | 1.137859 |
| ordinarySent | 9374 | 11032 | 1.176872 |
| maximumSent | 299 | 373 | 1.247492 |
| nearSent | 51272 | 52420 | 1.022390 |
| short | 3464 | 4612 | 1.331409 |
| unicodeSent | 27050 | 28198 | 1.042440 |

The measured maximum ratio is 1.331409; the production allowance is 1.5, followed by the required 2x factor and 4,096 bytes. The ordinary payload retains metadata (estimate 32,218); factor 10 yields 144,706 and fails its positive control. The raw maximum has three individually valid 8,192-byte objects with 64 overrides and is server-accepted when deliberately bypassing preflight; the actual producer omits them under total pressure. A near-limit base remains accepted after metadata omission, even though the conservative estimate still exceeds the threshold: preflight removes optional metadata, not the required base. The raw near payload is rejected by the real server. Valid UTF-8 model names pin byte counting independently of JavaScript string length.

The original margin mutant survived because the verifier recalculated the formula with its own 4,096. Commit `156e0917` changed the verifier to read the producer's estimate; the final margin mutant fails. Earlier green mutation output is not final evidence.

## Production-shaped startup

A clean tarball from the measured revision was installed into an owned temporary release root and launched through the installed shim. The runbook startup gate used a private copy of production config/environment with only connection fields replaced, `env -i`, and the actual production Node path. The loopback closed-port startup gate passed (outer exit 0; its bounded child timeout was 124). A local receiver measured a 695-byte register, estimate 6,181, limit 65,536, one engine, one retained metadata object, zero omissions. A string-valued boolean in the private copied config failed before connection (negative exit 1).

Archive SHA-256: `7a508f32abd521f954ea27dfa11a716d484621bdd60c9eac707bcf82b62a3c4d` (471,451,217 bytes). Manifest SHA-256: `6a512e23d9f0243fd5976285169d90103efbdbcd30b2d33d5463b71087012fb4` (169 entries). The large archives, temporary installed roots and private config/environment copies were removed after recording evidence. Production service, config and active release symlink were not changed. Deployment canaries remain a release-time requirement.

A 4,000-persona snapshot probe at the measured revision took 16.286083 ms and produced 4,000 overrides before whole-object omission. The earlier repeated resolver scan took 3,098.870421 ms. The implementation now resolves the uniform list-member policy once and copies it for each complete key. This is one observed timing, not a performance guarantee. The final built artifact hash is recorded in JSON; the committed test checks behavior and omission, not wall-clock timing.

## Negative controls

All **46** final mutations failed and were restored to the measured revision: 38 exit 1, 8 exit 2. Each record contains the changed path, exact command, failure summary, log hash and restored source hash. No process ownership or process-killing guard was mutated against the live host.

| Mutation | Exit | Observed failure summary |
|---|---|---|
| `outer-shape` | 1 | Tests  3 failed / 15 passed (18) |
| `engine-key` | 1 | Tests  2 failed / 16 passed (18) |
| `engine-shape` | 1 | Tests  2 failed / 16 passed (18) |
| `inner-key` | 1 | Tests  1 failed / 17 passed (18) |
| `boolean-type` | 1 | Tests  2 failed / 16 passed (18) |
| `ceiling-false` | 1 | Tests  1 failed / 17 passed (18) |
| `default-false` | 1 | Tests  1 failed / 17 passed (18) |
| `snapshot-env-copy` | 1 | Tests  1 failed / 17 passed (18) |
| `snapshot-frozen` | 1 | Tests  1 failed / 17 passed (18) |
| `json-bound` | 1 | Tests  1 failed / 17 passed (18) |
| `override-bound` | 1 | Tests  2 failed / 16 passed (18) |
| `utf8-byte-count` | 1 | Tests  1 failed / 17 passed (18) |
| `size-warning` | 1 | Tests  3 failed / 15 passed (18) |
| `resolved-default-register` | 1 | Tests  2 failed / 16 passed (18) |
| `relay-ceiling` | 1 | Tests  2 failed / 2 passed (4) |
| `reload-key` | 1 | Tests  1 failed / 17 passed (18) |
| `ceiling-guard` | 1 | Tests  5 failed / 4 passed (9) |
| `backend-guard` | 1 | Tests  1 failed / 8 passed (9) |
| `global-flag` | 1 | Tests  3 failed / 6 passed (9) |
| `invalid-list` | 1 | Tests  2 failed / 7 passed (9) |
| `refresh-stale-snapshot` | 1 | Tests  1 failed / 3 passed (4) |
| `refresh-process-env` | 1 | Tests  1 failed / 3 passed (4) |
| `rollback-runtime` | 1 | Tests  1 failed / 3 passed (4) |
| `docs-registry` | 1 | Tests  1 failed / 1 passed (2) |
| `wrapper-ceiling-parser` | 1 | Tests  2 failed / 106 passed (108) |
| `persona-override-generation` | 1 | Tests  2 failed / 16 passed (18) |
| `claude-code-child-ceiling` | 1 | Tests  2 failed / 2 passed (4) |
| `codex-child-ceiling` | 1 | Tests  1 failed / 3 passed (4) |
| `child-env-present` | 1 | Tests  1 failed / 3 passed (4) |
| `child-env-absent` | 1 | Tests  1 failed / 3 passed (4) |
| `register-preflight` | 2 | payload: %{reason: "payload_too_large"}, |
| `register-multiplier10` | 2 | Result: 2/3 passed |
| `register-multiplier1` | 2 | Result: 2/3 passed |
| `register-margin` | 2 | Result: 2/3 passed |
| `protocol-enum-drift` | 2 | test/launch_delivery_contract.test.ts(5,29): error TS1360: Type '{ operator_early: { fold: boolean; steer: boolean; hook: boolean; none: boolean; }; inter_agent_early: { fold: boolean; steer: boolean; hook: boolean; none: boolean; }; inter_agent_yield: { tool_boundary: boolean; none: boolean; }; }' does not satisfy the expected type '{ operator_early: Record<"fold" / "steer" / "hook" / "none", boolean>; inter_agent_early: Record<"fold" / "steer" / "hook" / "none", boolean>; inter_agent_yield: Record<...>; }'. |
| `dashboard-enum-drift` | 1 | svelte-check found 2 errors and 0 warnings in 1 file |
| `producer-client-divergence` | 1 | Result: 3 passed |
| `explicit-policy-priority` | 2 | Result: 2/3 passed |
| `existing-policy-preserved` | 2 | Result: 10/11 passed |
| `reload-early-publication` | 1 | Tests  1 failed / 3 passed (4) |
| `reload-snapshot-publication` | 1 | Tests  1 failed / 3 passed (4) |
| `antigravity-ceiling-default` | 1 | Tests  1 failed / 17 passed (18) |
| `antigravity-policy-default` | 1 | Tests  1 failed / 17 passed (18) |
| `missing-fixture-common` | 2 | test/launch_delivery_contract.test.ts(3,21): error TS2307: Cannot find module '../../../protocol/fixtures/launch-delivery-policy.json' or its corresponding type declarations. |
| `missing-fixture-dashboard-check` | 1 | svelte-check found 7 errors and 0 warnings in 2 files |
| `missing-fixture-dashboard-test` | 1 | Tests  no tests |

The stale-refresh mutation changes both capture timing and consumption; its intermediate `before_sha256` differs from the baseline, while `final_source_sha256` and `restored_to_head` identify the restored baseline. Built consumer mutations rebuild their affected artifacts; final gates and the clean release build ran after restoration. Removing preflight causes real-server `payload_too_large`; changing only the producer/client agreement causes a browser assertion failure even while the real-server cases pass.

## Limitations and unsuccessful runs

Two ordinary (100 ms receive budget) full-server attempts at seed 182700 observed failures in unchanged `delivery_policy_test.exs:683`; the retry also failed at `:293`. Both runs were stopped after observing the failures and are **incomplete**, not successful gates. The first BEAM shutdown returned exit 0 despite the observed assertion failure; the retry returned exit 2. The isolated test at `:645` passed with the same ordinary budget and seed (1 passed, 36 excluded, exit 0). An earlier full ordinary run at `156e0917` passed 2,147 with 1 excluded; it is historical rather than the final gate.

Hisui's decision (conversation `92594f01-1790-4ef1-a4fa-c53e3cc53eee`, turn 5) accepts the existing project CI profile (500 ms receive budget) as the formal server gate, treats these unchanged-test failures under host load as a separate issue, and prohibits changing their timeouts in this work. The final CI-profile full run passed. The director reported host load around 18; the timing explanation was not independently established by this implementation. Only the explicit integration test was added under `server/`; production server code and those existing tests are unchanged from the C2 base.

Dashboard standalone extraction without the shared fixture fails check/test by design; runtime still uses a client mirror and does not depend on `@kaoiro/protocol`. Oversized metadata and old-runner metadata absence share the same unknown-state UI without a reason marker. No native delivery canary, production activation, or proof of model-turn behavior is claimed. Worktree and build dependencies remain for implementation review and will be cleaned up after that work closes.
