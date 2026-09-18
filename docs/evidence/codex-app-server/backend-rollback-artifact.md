---
title: "Codex backend rollback and packaged artifact evidence"
status: recorded
last_updated: 2026-09-18
---

# Codex backend rollback and packaged artifact evidence

Historical Stage 1 increment (6), retained from [ADR-0058](../../adr/0058-codex-app-server-turn-steer.md).
The operator decision and landing were recorded on 2026-09-18 in the
[Stage 6 landing record](https://github.com/sakuraiyuta/kaoiro/issues/348#issuecomment-5726375118). The text below retains its original
measurement limits; this move does not re-run the artifact or certify a deployment.
The pinned binary identity and initial conditions are recorded in the
[Stage 1 compatibility evidence](stage1-compatibility.md).

### Increment (6): explicit launch selection and rollback

Runner-local `codex.backend` is a closed enum (`exec` / `app-server`), defaulting
to exec. It is relayed only for Codex as `WrapperConfig.codex_backend`, validated
by the wrapper parser, and selected at the CLI's single Host composition point.
The internal dependency override remains available to tests. Dashboard,
server spawn payload, resume snapshot, environment and argv do not select it.
The process-boundary config addition requires no wire-version change.

The setting is host-wide and takes effect for subsequent wrapper lifetimes;
config reload does not replace running children. Applied-config and wrapper
startup diagnostics identify the selection without a new wire field. Agent-level
selection is outside this increment. Both backends remain packaged, with no
implicit fallback, no Host-owned replacement child, and no IA steering. Existing
Supervisor restart limits and deliberate-stop behavior remain unchanged.

The pinned 0.153.4 CLI was exercised with a loopback Responses provider: two
app-server turns, complete child close, then exec SDK resume with the same UUID.
Prior user/assistant items reached the next provider request, rollout-based
display history retained the answers, and the new turn's permission observation
remained workspace-write / network disabled / approval never. Dropping the resume
ID produced a different UUID and failed the test. This measures persisted context
handoff, not an external model's reasoning or account authentication.

The runbook defines stop → explicit exec selection → applied-config receipt →
same-session resume. The artifact gate builds the Linux x64 runner tarball,
checks its manifest hashes, and exercises the packaged default launcher, wrapper
and native CLI outside the repository dependency tree. The runner's existing
session scan accepted the app-server rollout, its concurrent-resume lock rejected
a duplicate, and the exec resume restored the bounded display history. Live child
argv distinguished app-server execution from exec in this artifact probe.
Deployment itself is a
separate operator action. Darwin execution and production auth/model responses
remain unmeasured. Stage 2 steering and Stage 3 approvals remain separate decisions.
