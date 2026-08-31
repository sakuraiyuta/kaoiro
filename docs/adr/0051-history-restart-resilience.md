---
title: reconnect replay, IA sidecar, epoch replacement
status: accepted
date: 2026-08-08
opened: 2026-08-08
supersedes: []
superseded_by: null
related_specs: [protocol, protocol-inter-agent, architecture, deployment]
related_adrs: [12, 14, 30, 36]
---

# ADR 1 — reconnect replay, IA sidecar, epoch replacement

## Status

Accepted(2026.08) Home Specification Review 2 patrol (10 m -fix)
Approve, Master Final Approved

## Context

### observation in dogfood(2026 08)

After restarting the docker container of the server, the display is unmatched between the operator terminal
observation:

- Dashboard tabs open before reboot, client-side merge
(`projectAndMergeHistory`) toTemperature because the local buffer is heated
Continue to display the log before the reboot that does not exist anymore (ghost display).
- The newly opened tab is almost empty (as the volatile ring buffer disappeared).
- The most recent work log is on any device unless wrapper is started.
Don't return.

### Determination of requirements (Master Judgment 2026 08)

- You can see the same screen  on any operator terminal.
- F5 Reload, including your own sending/agent reply/IA message
displayed as the original.
- The server must be restarted.
- On the other hand, the durable state that the server is affected is sharpened only. history
wrapper host (wrapper transcript + ADR)
IA sidecar

[ADR-0014](0014-session-resume-and-restore.md) A4
"Operation running" almost meets this requirement, but restart resistance is not scoped
Comment All history server
([#24](https://github.com/sakuraiyuta/kaoiro/issues/24))
Keep it unadopted (not changed in book ADR).

### Description drift correction

"`inter_agent_message`" injected to the SDK
routing metadata can not be reversed from text and cannot be rebuilt from JSONL.
server DETS-backed `InterAgentHistory`
Issue #102 In the current implementation, the reception side injectionamaming
`conversation_id` / `turn_number` / kind / sender / body
and drift
It is a description. However, the parsing of text for display and model is used as a means of restoring
that itself is vulnerable (the past history will not be read by format change),
not taken (see Alternatives).

## Decision

### D1 — history wrapper host composite SSOT (A4)

wrapper host**composite SSOT**Name:

engine transcript
  `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`,Codex =
  rollout file).
- Structural IA: Same as engine transcript**IA sidecar**(D3).

The displayhistory of the server can be rebuilt from the wrapper host
issue #24(. All history persistence)
`InterAgentHistory` in this ADR
Remove DETS (D3), do not add durable display system state
(`ClearWatermarks` remains existing, see D3-4).

### D2 — hydration handshake by replay

server is an agent**hydration state**Lifecycle
(volatile per Agentboos and boots) and request replay on the basis
displayhistory is 0 — partial
replay(reset after a few pieces and cut)
Because there is a spill.

- **State**: `unhydrated` / per agent
`in_flight(replay_id, channel_owner)` / `hydrated` boot time
`unhydrated`
- **join handshake**wrapper channel join
Home hydration control)
`replay_id`** wrapper for the new server.
Start replay after receiving verdict (current startup unconditional)
replay does not go to new server opponents — "Unconditional startup replay"
If hydrated, no waste replay is required by the wrapper.
not to know more).
- `required: false`(hydrated)→ not replay. server
wrapper pre-knowledge that normally reconnection does not run replay
Close
- `required: true` `replay_id` `history_reset` /
`replay_ia` / `history_replay_complete`**Integrated Use**
dashboard reset/complete pairing and server hydration transition
does not leave race due to ambiguity of ID.
- **legacy fallback**: join ReplyHome verdict  (former server,
capability absent) wrapper scoring ID
replay.
- **Complete transition CAS**: `history_replay_complete`
channel owner matches `in_flight`
Contact Us `in_flight` if the channel of the owner is cut
Return to `unhydrated` and re-request at reconnection. connectionle old connection
/ complete is ignored in CAS and new connection
not rewind attempt.
- **fresh session**: session id Unsigned / transcript
wrapper replay(`history_reset`)
`history_replay_complete`)
Yes.
- **wrapper side single-flight**: 1 attempt only execution and separate during execution
When the request comes, it responds with the completion of attempts during the execution.
- **hydrated disable conditions**(2026 08) Home Q1. Original Edition
hole: server**transition with resume session id at the starting point**
(restore binary session id  ・resume session)
switch / disconnected resume)
invalidate and request replay in the next join. `/new`
`history_reset` of empty replay
invalidate to break ADR-0036 F3 display maintenance / marker display
not. Crash-restart
The same session does not invalidate because it is already positive.

replay only for current session. `/new``/clear`
Previous) Reconstruction is not scoped (receptedHomeーHome, D7). Both engine
transcript replay
`wrapper/codex/src/history.ts` + `rollout.ts`).

### IA sidecar`InterAgentHistory`DETS removal

#### D3-1 per-pane projection contract

Server IA Volatile Index**per-pane projection/upsert API**Home
replayinglive(D3-3)
`replay_ia`) shares the same contract. Live display /
F5 Restoration is responsible for the current "Agentgents sender history +
DETS fan-out

- **Live Accept**server**ing  stamp** →
sender pane + receiver pane
(peer push)
`route_inter_agent`**Home**Home
fixed). routing, etc.
All tests that can be confirmed by **reject, including preflight
Added to ** before upsert. routing after upsert is onlyerer push
and the protocol statement that the rejected IA does not remain in pane
(30-2) and server test pin (Home 2 patrol approve)
non-blocking note).
- server envel (`agent_id: "server"`)
recipient pane
- clear filter(D3-4) and final pane cap(D6) are also applied on this route,
live / replay
- **upsert identity is `ing  stamp|pane agent id`**. IA
sender/paneeiver copy only shares stamp and pane. Replay
retry is equal to upsert to key. conversation|turn_number`
does not use identity — server   notification is always turn number=0,
To cause multiple occurrences of the same conversation and the same pane
(see Alternatives).

#### D3-2 Record (append to sidecar)

wrapper envel  `inter_agent_message`
append to local sidecar file per ing  stamp (
`<session-id>.ia.jsonl`
path Schema is determined by the protocol-inter-agent revision).

- **Receiver pane**: At the time of delivery from server (before S  injection)
append. The delivery envel  contains the D3-1 numbered stamps
Home Only sidecar remains phantom when injection failure is accepted ( buted
as a record of the facts). server Syn  envel  is also received
Likewise recorded.
- **pane**: **transport push**
record. server is server → stamp number → per-pane projection
Reflecting → routing accept as a reply to that push
`{ingress_stamp}` and wrapper**ack at the time of arrival** append
MCP tool result(`send_to_agent` response) is server ack
not used — the current implementation tool result is a local generation string,
`wait_for_response=true` does not return toerer reply / timeout
so if you delay append, you can cross the session generation
(Home 2 patrol must-fix 3). MCP'serer reply wait is another promise
Contact Us reject / timeout / ack Loss does not record to sidecar,
display the result (loss is acceptable, exposed by stderr warn).
- skip + stderr warn(fail-soft) fsync
Not required. transcript directory
session id does not follow sanitize Splink.

#### D3-3 Restore (replay only ing )

Restore sidecar**Display replay**and usually
`envelope` `route_inter_agent`
Re-push to the destination wrapper → cause the SDK re-infusion and not history restore
To become a conversation reexecution (Home 1 patrol must-fix 1). Also save the receiver
The sender name envel  cannot be sent to the guard.

- New message (name is determined by the protocol revision.) Example: `replay_ia`)
replay stream`{pane_agent_id, original_envelope,
  ingress_stamp, replay_id}`to carry.`replay_id`D2 server number
  ID.
- server verifies that the topic wrapper is the pane owner
D3-1 projection contract to upsert: routing
Conversation s・peer wrapper push・S  injection
Not touched.
- **pane ownership**: Each wrapper from your sidecar
restore only pane-local view (sender pane is sender sidecar,
receiver pane is receiver sidecar). Offline
pane returns to standalone. Dualification by both sides having the same IA
  `ingress_stamp|pane agent id` upsert
- resume the same upsert in the server survival resume (reset → replay)
`history_reset`
  **Disco ed as Meaning**wire field
explicitly send `false` — old dashboard interprets omitted as `true`
So if you delete it simply, the old IA remains in the new server reset (D6 rollout
Reference. field physical removal is another step after the old client tab disappears).

#### D3-4 clear Matching with the border (ing  stamp)

`/clear``clear_history`
[ADR-0036](0036-session-lifecycle-commands.md) server
ing -order sidecar new ing  to re-intake
If the order is shaken, the cleared IA is revived:

- ing st stamps are numbered at live accept as D3-1, and can be
ing -order domain wrapper
Saveplayatim and replay.
- `ClearWatermarks` (existing DETS,
Maintenance**Saved stamp**Compare and apply per-pane hide

- line without stamp (legacy / corruption)**fail-closed**
Return to `ts` comparison of wrapper clock reintro clock clock-skew problem
Not available

#### D3-5 session lifecycle

- **session id**: Fresh wrapper
There is no session id, and IA can arrive between them. This is
  **pending journal**append and session id
bind(rename) pending journal
  **`{agent_id, reset_generation}`**the same cwd
Do not collide withact fresh wrapper and rollback (exact path isClash
Close bind before crashed orphan journal is not replay,
Fail-closed
- **`/new`・`/clear`**: Stop append to old generation, and new
generation to generation(Next pending → New session sidecar).
reset rollback
- **Remove agent**: wrapper host in server store purge
transcript / sidecar does not disappear. Like engine transcript
"host local factfact remains" (removal semantics of ADR-0030)

- Existing `InterAgentHistory` DETS data is destroyed without migration (dogfood)
Accepted). IA history session Reconstruction is disco ed and same as other history
Unify to "current session minutes only". This is current**Intentional re **
(D7 (b)).

### D4 — client resynchronization by projection epoch

- **epoch**: Agent Agents opaque
UUID equivalent**Lifecycle**). container Restart
Not only Agent s, but also non-consolidated crashes.
epoch is the same, but there is no lie (the limit is D7 (d)). Restart
No collision or time.
- **client**(not simple subst tion — join  , history
to not drop a legitimate live envel  to reach new connections earlier than push):
1. Join**live envelJapanese term**Home
baseline and separation buffer.
2. `history` push epoch is unmatched with the retention value → destroy the old baseline
(Target: display log, clearWatermarks, resume replay marker,
unread/new markers, etc.)
authoritative history + new connection buffer
3. epoch matches → merge (`mergeHistories`).
4. epoch is absent(former server)→ fallback(ghost is
remains compatible).

### D5 — separation of process recovery and display restoration

- **Restore agent processes**(resume-spawn)
[ADR-0030](0030-agent-directory-and-explicit-restore.md)
  / issue #41).
- **Restore displayHome**Automatic (D2). If wrapper is alive and reconnection
timeline returns without the operator operation.
- offline agent(when wrapper stops), the history of resume operation is empty. tile
offline display so there is no contradiction on UX, and the scene of history is real
"Restore and continue the scene"

### D6 — cap unification and rollout

- **cap**: displayhistory cap pane IA transcript line and IA
time series merge, dedup, filter**Final orientation**in Forum 200
Envel. transcript 200 + sidecar 200
not 400. The same cap is added to the receiver pane. IA
cap exemption (issue #102) is abolished.
- **rollout**: Change over server / wrapper / client
(Combination 8),**deploy order is not optional**Home Main when mixed
Deterioration: The new wrapper + old server does not have stamps on ack and is on sidecar
Unable to record (this window IA is not restored), new server(DETS)
decommissioned) + old wrapper does not have sidecar
epoch・`preserve_inter_agent`

- This phase assumes dogfood**atomic maintenance rollout**dopt
Fixed as operating conditions:
1.Maintenance window does not send IA.
server / wrapper / dashboard
2. Reload all dashboard tabs after updating (Remaining the old JS tab)

3. `preserve_inter_agent` indicates the compatibility period `false` as D3-3
Submit and physical  are followed.
- If the step rollout is required (for future multi-host term operation)
Reference procedure: (1) Add server(stamp/ack/hydration/`replay_ia` +
DETS T  dual-write → (2) wrapper update (sidecar start) →
(3) client update → (4) check old wrapper absence and final server
DETS removal. This phase does not implement.

### D7 — AcceptedHomes

- (a) offline agent history is not displayed until resume operation.
- (b) Only the current session will be restored after restarting. IA IA
Abolished overlap recovery, D3-5).
- (c) several seconds from server restart to wrapper reconnection + replay completion
timeline is blank.
- (d) Agent crashs (root supervisor is one for one)
Don’t guarantee complete recovery: epoch changes, but existing connection dashboards
history Not reaching push **The spirit remains until the next reconnect / F5
wrapper rehydration delays to the next wrapper join
"Slele merge" guarantee was joined after epoch change
to client. server process
Restart.
- (e) sidecar records as D3-2
loss/received failure phantom (without fsync).
- (f) rollout depends on the 6ic maintenance condition of D6.

### D8 — protocol

5 points to add/modify the protocol:

wrapper channel join
replay   + server   `replay_id`(D2)
2. W→S replay IA ing  (`replay_ia` temporary, D3-3)
3. ing st stamp: grant to envel
(Phoenix push reply)
4. `history` push projection epoch(D4)
5. `history_reset` `preserve_inter_agent`: Meaning and compatibility period is
`false` (D3-3)

amendment sweep for existing documents:

- [ADR-0014](0014-session-resume-and-restore.md) A4 IA "Reverse"
"Invalid" description and issue #102 supplement (refer to this ADR)
- [ADR-0036](0036-session-lifecycle-commands.md) F3(IA visibility
cutoff DETS ledger premise → sidecar + stamp approach)
`preserve_inter_agent` [protocol](../specs/protocol.md)
`InterAgentHistory` description, `delete_agent`, purge store number
- [ADR-0030](0030-agent-directory-and-explicit-restore.md) D6
store number description (already because drift is drhronized to this occasion)
- [deployment](../specs/deployment.md) DETS path 8 → 7

## Consequences

### Positive

- server reboot, live agent timeline does not operate
restored. All the operator terminals have the same display and F5.
- Reduces server's durable state (`InterAgentHistory` DETS removal).
-Spiritle tab demolition display is eliminated (D4).
- live and replay are included in the same per-pane projection contract,
(current sender history + DETS fan-out double structure)
disappear.
- The principle of wrapper host and wrapper is composite
Consistent as SSOT without exception.

### Negative

- IA history session Restore overlap (D3-5, intentional).
- Implementing sidecar recording, reading, and generation management on the wrapper side
(common).
- There are 5 additions and changes, and rollout is  ic maintenance.
Depends on operating conditions (D6).
- Reboot time zone (D7 (c)).

### Neutral

- transcript replay path/dedup border (`history_reset` /
`history_replay_complete`)
- Influence on threat model: hydration verdict is new in S→W
`replay_ia` has pane ownership validation and is updated only.
sidecar is the same boundary as host local (transcript T1). IA
Meta operator Limited delivery (T2) is unchanged.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|A:display displayhistory on the server side (#24 reopen)|Replication of transcript becomes the second one, and new drift matching problem with /clear,cap, and replay. The advantage is "offline agent", "history display" and "past session retention" only.|
|Draft C: Current Status + GhostSpiritification Only|The history disappears after restarting and does not meet the master requirements (the same display of all terminals over restart)|
|B-1: Injectamaming Text  IA Restore|Long-lasting  ttle handling of text for display and model as serialization format (with format change, past history can not be read, error parsing,   separate tool use shape difference)|
|IA DETS|The implementation cost is zero, but there are exceptions in the "Minimizing State" principle. Select the option to remove the exception at the cost of sidecar (small to medium)|
|IA replay`envelope`Retransmission by route| `route_inter_agent`re-press to the destination wrapper → re-inject the SDK and re-execution history.`agent_id != topic`guard and also collision (Home 1 patrol must-fix 1)|
|replay trigger = "displayhistory 0"|After partial replay, unfinished, unfinished, and permanentized the take-off (Home 1 patrol must-fix 2)|
|startup Unconditional replay maintenance (join ver)|If hydrated, the pairing of the wrapper scoring ID and server scoring ID remains ambiguous (Home 2 must-fix 2)|
|MCP tool result Used for server ack of sidecar|tool result is a local generation string,`wait_for_response=true`append crosses the session generation (Home 2 must-fix 3)|
| dedup identity = conversation_id\|turn_number\|pane |server pane notification occurs multiple times in the same conversation and the same pane with turn number=0 fixed (Home 2 patrol must-fix 4)|
| `preserve_inter_agent`Instant field removal|Old dashboard omitted`true`The old IA remains in the new server reset (Home 2 must-fix 5)|
|clear wrapper`ts`Comparison|Re clocked clock-skew problem (Home 1 patrol must-fix 3)|
|epoch Disruption of local|join  live・history Loss to a legitimate live envel  that arrived in the new connection before arrival (Home 1 patrol must-fix 4)|

## Related

- Revisedss / ADR: See D8.
-Japanese term plan: [phase-30](../plans/phase-30-history-restart-resilience.md).
-: issue:
  [#24](https://github.com/sakuraiyuta/kaoiro/issues/24)
(Unadopt),
  [#41](https://github.com/sakuraiyuta/kaoiro/issues/41)
(i.e., unchanged),
  [#50](https://github.com/sakuraiyuta/kaoiro/issues/50)
(replay path),
  [#102](https://github.com/sakuraiyuta/kaoiro/issues/102)
(Idealed by IA DETS, book ADR)
- Specification review: Home 1 patrol 2 patrol 2026 2008 (conversation)
  0b5c31a4).
