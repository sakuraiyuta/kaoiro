---
title: Runner user-systemd instance without linger evidence
description: Observed on one host that, without loginctl enable-linger, the user systemd instance restarts on every SSH connection and takes the enabled runner unit with it.
status: recorded
last_updated: 2026-09-26
related: [deployment]
---

# Runner user-systemd instance without linger evidence

**Measurement record (2026-07-26, linux-host / Ubuntu, systemd user
instance, real host over SSH; issue
[#142](https://github.com/sakuraiyuta/kaoiro/issues/142)):** the runner ran
as the `kaoiro-runner` systemd user unit installed per the
[runner install runbook](../../operations/runner-install.md#linux-systemd-user-unit),
on a host where `sudo loginctl enable-linger` had **not** been run.

Observations:

- Within a single SSH session the unit's restart policy behaved as declared:
  after SIGKILL the unit restarted (PID changed); after exit 78 (`EX_CONFIG`,
  config removed) it stayed failed for 10 s without restarting.
- Across SSH sessions the user systemd instance itself restarted on each new
  connection, and the enabled unit restarted along with it. Read naively, the
  changing timestamps look like the unit restarting on every connection; it
  is the instance, not the `Restart=` policy.

Limits:

- `enable-linger` itself was **not** verified on this host: it needs `sudo`,
  which required a password there and could not run non-interactively.
- One host, one systemd version. The behaviour follows from user instances
  being started per session when linger is off, but repeat the observation
  when the host or systemd changes.

The runner build under test is not recorded in the issue; the verification
report closed with the merge to `main` at `fb2ea36` (2026-08-23).

## See Also

- [Runner install and distribution](../../operations/runner-install.md#linux-systemd-user-unit) -- the procedure and the rule derived from this observation.
- [Runner service isolation](runner-service-isolation.md) -- the other dated user-systemd measurement.
