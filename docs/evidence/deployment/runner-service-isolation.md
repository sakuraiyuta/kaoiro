---
title: Runner service isolation evidence
description: Measured cgroup isolation between a systemd-run --no-block caller and its detached worker unit, on one host.
status: recorded
last_updated: 2026-08-16
related: [deployment]
---

# Runner service isolation evidence

**Measurement record (2026-08-16, linux-host / Linux 6.8.0-137-generic, systemd
user instance):** the caller entered
`/user.slice/user-1000.slice/user@1000.service/app.slice/kaoiro-selftest-caller.service`,
while the worker entered a **separate cgroup** at the same `app.slice/kaoiro-selftest-worker.service`.
After `systemctl --user stop` stopped the caller, the worker wrote its sentinel and
exited `Result=success`; the active `kaoiro-runner` remained unaffected. **Repeat
the measurement when the host changes**—this is observed on one host, not a
guarantee for every systemd configuration.

## See Also

- [Runner service verification](../../operations/runner-service-verification.md) -- the procedure that produced this measurement.
- [Runner update and rollback](../../operations/runner-update-and-rollback.md).
