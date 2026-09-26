---
title: Issue 422 notification admission round 4
status: in_progress
last_updated: 2026-09-27
---

# Issue 422 notification admission round 4

## Measurement contract before implementation

The measurement enters the final built `runClaudeCli` composition. It supplies isolated CLI arguments and config, constructs real `ServerLink` and `AgentHost` instances, and delegates MCP registration to the production `buildKaoiroMcpServer`. It does not construct an `InterAgentTool` or copy the CLI's `canSendInterAgent`, Host fail-stop, turn coordinator, or inbound formatting wiring. A real peer sends ordinary envelopes through a joined server channel; the CLI receives them and forms the SDK inputs. The probe counts wrapper attempts, server acceptances, and peer deliveries separately. SDK hooks and prompt logs verify that the exact peer body, CID, and turn number reached the model input.

The observation wrappers call the original callback exactly once with the same `this` and argument identities, without an observation-only `await`, and return its value or Promise or propagate its exception unchanged. They preserve every production `createHost` option, including `prepareInput`, `onTurnStart`, `onTurnEnd`, `onPromptAdmitted`, both fail-stop callbacks, `queryOptions`, and hooks. MCP delegation forwards the inter-agent tool, Claude-only tools, and `resolveOrigin` unchanged. A controlled test pins call count, argument identity, unaffected option reference identity, return/Promise identity, and thrown errors. The exercised observer source is retained with a SHA-256. Only the deliberate barrier and interrupt in the retired-call probe alter ordering.

For (c), the observer holds an actual root `send_to_agent` invocation that arrived through the SDK MCP callback, after `resolveOrigin` supplied T1's origin and before the original `InterAgentTool.invoke`. At capture, the T1 origin must exist and have a live signal. The observer retains the original context and call; it never resolves a new origin or generates a replacement call. It triggers the CLI's interrupt path, then waits for the production `onTurnEnd` of T1 and an aborted T1 origin signal. It admits a distinct T2 through the real CLI inbound path and waits for its SDK prompt and live admitted token. Only then does it release the original invocation. The same T1 context must remain aborted, T2 must have a different live token, the original invocation must finish, and wrapper-to-server attempts from that old call must be zero. Missing capture, release, terminal event, or invocation completion is a nonzero probe failure. This is a controlled delay applied to a real SDK call, not an observed spontaneous delay.

The fail-stop negative evidence has two separate controls. The first drives a real Host failure into its CLI fail-stop callback and checks the state/error and outbound effects. The second uses a valid token in the real CLI composition, changes only the CLI admission decision, and checks that common-tool sending stops with `admission_fail_stop` and zero server attempts. A mutation removing the CLI callback connection must make this second control fail without ToolOrigins abort masking it. Together with actual SDK/MCP normal sends in (a), (b), Bash N→N2, and Agent root/child, these controls cover both sides of the production connection.

The previous round's probes omitted the production admission callback and are historical observations only. This round's native gates must be bound to the final source and built bytes; a green process without a captured (c) call or without an actual SDK prompt is not a valid result. Model API dispatches include excluded exploratory runs and are counted from SDK debug records.
