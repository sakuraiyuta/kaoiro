# Claude compact resume ordering

Related: [issue 991](https://github.com/sakuraiyuta/kaoiro/issues/991).
Design measurements used revision `f706c8c6f79c158f771e474f062abfdb48d8a371`,
SDK 0.3.306 and bundled CLI 2.1.306. They entered through built `runClaudeCli`
with real Host, Monitor, `request_compact`, native hooks, transcript and results.
The model provider and Phoenix service were loopback fixtures. No credentials
or production session were used.

The original failure sets `#intervalAmbiguous` at the fresh notification hook:
`active !== null && !uniqueWrapper`. The active token belongs to a resume note
that the SDK pulled but has not admitted. The notification's terminal then
fails ownership validation. Both model inputs may still arrive after that host
failure, so observing note text alone does not establish success.

| Native schedule | Observation |
| --- | --- |
| Notification during compact; text-only turn | Notification and resume have separate prompt IDs/results |
| Notification during compact; foreground tool boundary | Default-priority note can share the notification prompt ID and result |
| Note with `later` | Separate resume root in native and legacy modes |
| N1 enqueue, note enqueue, N2 enqueue before N1 completes | `later`: N1, N2, note; `next`: N1, note, N2, in both modes |
| `next` at a foreground tool boundary | Note folds into the notification in both modes |

The compaction result reported `queued_turn_count=0` despite the notification
already being enqueued. The SDK excludes system queue entries from that count.
Transcript queue history is observable but is not an atomic next-root claim.

Authority experiments routed only the reserved note through `Query.streamInput`
to avoid the baseline early-active bug. They did not fabricate native ownership.
The folded native turn could reply and start a new thread using its launch-bound
lease. The measured legacy Monitor event stayed foreign, so both IA operations
were rejected even though ordinary Bash work succeeded. Separate product-root
controls succeeded in both modes. The raw-SDK input fixture deliberately lacked
wrapper note admission and was not evidence of an integrated fix.

Negative controls failed as intended: the baseline no-fail-stop assertion;
removing `later` while requiring distinct prompt IDs; requiring FIFO with a
later-enqueued notification; and requiring a distinct root with `next` at the
tool boundary. These observations motivated a pending receipt plus `later`,
with an absolute wait limit rather than a fairness assumption.

## Candidate verification

`wrapper/claude-code/test/compact_resume_native.test.ts` uses the product input
path, without the design probe's `Host.send` interception. It observes callbacks
and real tool origins; only the starvation cases shorten the Host total budget.
It checks note reply/new-thread operations, ordinary file work, actual native
lease versus foreign occupancy, a subsequent normal input, and visible deadline
failure. Successful admission of the multiline prefixed note also establishes
that its final prepared-text digest matches the actual hook bytes.

Run through the project's remote-test launcher after building the wrapper:

```sh
pnpm -C wrapper build
pnpm -C wrapper/claude-code typecheck
pnpm -C wrapper/claude-code test test/host.test.ts test/compact_resume_native.test.ts --maxWorkers=2 --minWorkers=1
```

Bind results to the exact candidate revision and launcher run. Host fake-hook
controls establish refusal, clock and barrier decisions; they cannot establish
native queue scheduling. Keep the native cases on dependency-pin upgrades.
