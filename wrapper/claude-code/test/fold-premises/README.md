# Fold premise harness (E1 to E4)

Re-measures the input-folding premises E1 to E4 of the
[2026-09-28 fold measurements](../../../../docs/evidence/issue-429/2026-09-28-claude-fold-measurements.md)
against the installed Agent SDK and its native CLI. It runs at an Agent SDK
bump ([checklist](../../../../docs/contributing/agent-sdk-bump.md)), not in CI,
and not under vitest. The provider is a scripted Anthropic Messages endpoint
on loopback with a dummy key, so no real model request is made and no network
is needed.

| File | Role |
|---|---|
| `probe.mjs` | runs one schedule (B0, F1, T1, P1, F2) through `runClaudeCli` and records requests, events and responses |
| `seam.mjs` | pushes the live input into the running query |
| `checker.mjs` | extractor only; writes `<run>.check.json` and asserts nothing |
| `judge.mjs` | the judgement table J0 to J27 and the expectation mutations for the negative controls |
| `harness.sha256` | the identity of the four files above, checked before any probe runs |
| `run-all.sh` | the driver: five schedules, extractor, judge, negative controls N1 to N10, positive controls, one summary |

## Identity

The four files are those of the 0.3.319 and 0.3.321 records
([0.3.319](../../../../docs/evidence/claude/issue-1044/sdk-0.3.319-2026-11-07.md),
[0.3.321](../../../../docs/evidence/claude/issue-1063/sdk-0.3.321-2026-11-10.md)),
byte for byte. `judge.mjs`, `seam.mjs` and `checker.mjs` keep those hashes; a
bump that needs to change one of them leaves the standing design
([ADR-0074](../../../../docs/adr/0074-standing-design-for-engine-pin-bumps.md)).
The only later edit allowed within it is one to `probe.mjs` that keeps handing
the wrapper the same input in the form the wrapper currently takes it. Two
examples: a no-op method added to, or aligned on, the server-link stub that
`createServerLink` returns, when the wrapper starts calling a new link method;
and the root prompt passed through the configuration stub, since the wrapper
reads it from the launch file
([ADR-0076](../../../../docs/adr/0076-single-kaoiro-entry-point.md)). The
values handed over, observation forwarding (`rec`), the payload and schedules,
the `query` options, the scripted responses and the judgement stay unchanged.
The same commit updates the `probe.mjs` line of `harness.sha256`, and the
implementation reviewer of that change checks both.

The judge keeps the gaps the 0.3.321 record names: `J17`, `J20` and `J21`
have no falsifying and no positive control.

## Running it

The driver expects this layout, as provided by a container or a `bwrap`
root:

- `/w/repo`: the checkout at the commit under test, with dependencies
  installed and the wrapper built (`pnpm install --frozen-lockfile`, then
  `pnpm build` in `wrapper/`); the probe imports `wrapper/claude-code/dist/`.
- `/w/e`: a writable copy of this directory.
- `/w/out` and `/w/scratch`: empty and writable.

Run `sh /w/e/run-all.sh`. Exit 0 with the last lines `ALL NEGATIVE CONTROLS
BIT` and `J0 and J1..J27 all PASS on the unmutated expectation` means 55
judgements passed and every control bit. Any other end is a failure: a `FAIL`
line refutes a premise, while a `J0` failure followed by `SKIP` means that run
was not established and gives no verdict.
