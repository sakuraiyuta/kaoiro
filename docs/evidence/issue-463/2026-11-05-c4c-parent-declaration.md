---
title: C4C parent Claude declaration observation
status: measured
last_updated: 2026-11-05
---

# C4C parent Claude declaration observation

For [issue #565](https://github.com/sakuraiyuta/kaoiro/issues/565), the parent
of the C4C commit stack is `cc58553495255f075b8bcc873fb095c576125a3d` (C4B U2).
A disposable observation built that exact commit, then launched its built
Claude CLI with production ServerLink, Host and pinned native SDK/CLI.
Only the loopback Phoenix and model-provider endpoints were scripted.
The committed tests do not build the parent or include the disposable probe.
The fixed declaration is in
[the generation fixture](../../../protocol/fixtures/claude-delivery-generations.json).

Run: `fuji-cc58553-565w1-1105222814-cde0.e178444dfd5283d1`, class `test`,
image `sha256:ca00bbbd878662d0fec8acd87fffe50384a04aa93e25f4e0bcf7f6b3673296b4`.
Prepare: `corepack pnpm install --frozen-lockfile && corepack pnpm -C wrapper build && corepack pnpm -C runner build`.
Body: Vitest ran one disposable observation file with one worker.
Result: pass, exit 0, three tests. Body stderr was empty.

| Parent input | Actual early / yield declaration | Policy v1 echo / revision-1 ack | Accepted folds | Result turns |
|---|---|---|---|---|
| File key true | fold / tool_boundary | yes / yes | 1 | 1 |
| Old inputs absent | none / none | yes / yes | 0 | 2 |
| File key false | none / none | yes / yes | 0 | 2 |

Each case started a native tool turn and sent an early operator input while
the owned tool waited on a local barrier. The provider later received that
input in every case. Enabled folded it; absent and false queued it normally.
The source's FIFO behavior under disabled W1 mechanisms was inspected in the
parent's CLI negotiation and Host root selector; this run did not measure
queued-peer-versus-operator order. W2 ordering has separate implementation tests.

This is finite local-provider evidence, not production authentication, billed
model behavior, historical S0 deployment or timing parity. The S0 display
matrix is a current-client fallback with policy echo absent. The parent
observation must be repeated if the C4C stack's parent changes.
