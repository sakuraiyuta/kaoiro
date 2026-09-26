---
title: Issue 407 reconnect generation and permanent adapter controls
date: 2026-09-26
status: pending-review
---

# Reconnect generation and adapter controls

The round-seven review found that a send captures negotiation mode before the
CID lock. A preceding acknowledgement can hold that lock across rejoin, leaving
a queued send formatted for an old mode. Phoenix buffers channel pushes while
unjoined; rejecting at the server is too late to prevent crossing generations.

Retain immutable input/ticket capture at invocation, but read negotiated mode
inside the CID lock after waiting for rejoin. Capture ServerLink's join generation
with that mode and pass it to the synchronous dispatch boundary. ServerLink
refuses protected inter-agent pushes unless the generation still matches, the
mode is settled, and the socket/channel are joined. No protected inter-agent
push enters Phoenix's disconnected buffer. Socket loss, channel error/close, and
join invalidate old generations. Already-written pushes retain their ordinary
ack/unknown semantics and are never automatically retried. Local refusal is
explicitly not attempted; valid consumed authorization can be reissued for an
intentional retry, using the existing definite-nonacceptance handoff contract.
Internal notices use the same generation guard. Generic state/task buffering is
unchanged, and AG v1 remains disabled.

Moving only the mode read would fix the CID example but leave disconnected
buffering unprotected. Checking only transport mode would miss a same-mode
rejoin; an explicit generation is needed. No server/protocol wire change is
required. Tests cover both mode transitions with real ServerLink/Phoenix and a
held first acknowledgement, channel-only rejoin, and delayed old-generation
sends. Deterministic regression tests traverse the real app-server session
resolver/ToolHost and the real Claude SDK MCP registration/callback; external
transport is controlled. Existing real native loopback probes remain complementary
evidence. Remove each new guard/wiring once and require red, restore and require
green. Run wrapper build/typecheck/full tests and server full/format gates; the
reported pre-existing server seed failure is outside scope. Update the reply-basis
reference and append content-bound evidence without rewriting prior observations.
