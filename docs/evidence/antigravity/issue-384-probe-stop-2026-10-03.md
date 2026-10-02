# Issue 384 `/usage` probe stop measurement

## Question

Does killing the direct `agy -p /usage` process by PID leave a descendant holding
its stdout pipe open, preventing Node's child-process `close` event?

## Environment and method

- Date: 2026-10-03 JST.
- Repository baseline: `d68a0165c713996ecbe94285ce1d66e82f1bb0c7`.
- `agy`: 1.2.14, binary SHA-256
  `0d0d3eba22daf29504dd290151c7ed9a4d33b0c6aa0acfc5da27bc3b01d2f029`.
- Isolation: `scripts/run-antigravity-test-namespace.py` (SHA-256
  `c4565aa31eac88f1e28174cc867801bb8f0e0f03840fde05e110895c98251db2`),
  which runs the command under outer and inner `setsid` and a user/PID
  namespace.
- Each trial spawned `/home/yuta/.local/bin/agy -p /usage --output-format json`
  with stdout and stderr piped. The harness inspected only the process tree
  rooted at its own spawned PID and compared descendant file descriptors with
  that child's stdout pipe. It sent `SIGKILL` only to that held child PID.
- The run was bounded by `timeout 120`; wrapper exit was 0 for every trial.

## Results

| Trial | Stop action | `exit` | `close` | Descendants at stop / after 2 s |
|---|---|---:|---:|---|
| 1 | PID `SIGKILL` at 1,507.5 ms | 1,525.4 ms (`SIGKILL`) | 1,525.5 ms (`SIGKILL`) | none / none |
| 2 | PID `SIGKILL` at 3,014 ms | 3,031.3 ms (`SIGKILL`) | 3,031.4 ms (`SIGKILL`) | none / none |
| 3 | no signal; `/usage` completed | 5,577.8 ms (code 0) | 5,577.9 ms (code 0) | none at completion |

The two killed trials emitted no stdout or stderr before the signal. The
completed trial emitted 1,902 bytes on stdout and none on stderr; its contents
were not retained because they may include account-specific usage values.

## Decision and limits

On this `agy` binary, the direct `/usage` process had no observed child process
at either PID-signal point, and its `exit` and `close` events followed the
signal 18 ms apart. Keep the probe's `signalTarget(child, "pid", "SIGKILL")`
destination and use `close` as the settled-child signal. This measurement does
not establish behavior for a future `agy` version or other commands.

If the two-second stop bound expires without `close`, retain the child handle
in `stop_timed_out` and do not start another usage probe. A later `close`
releases the handle, returns to `idle`, and counts exactly one failed attempt
while the host remains open. If the host is already closing, release the
handle but remain closed and do not retry.

Raw structured captures are retained under `/tmp/momo384-stopprobe/` while
issue 384 is open. They contain timing and process metadata only; no account
identifiers, tokens, or `/usage` output.
