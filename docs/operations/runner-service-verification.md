---
title: Runner service verification
description: A one-time-per-host manual self-test proving systemd-run --no-block starts the runner update in a separate cgroup from its caller, so stopping the runner does not kill an in-flight --detach update.
status: accepted
last_updated: 2026-09-27
related: [deployment]
---

# Runner service verification

## 4.6.4 What tests do not guarantee (verify once on real hardware)

Deterministic tests pin the arguments passed by the update script to `systemd-run`
(`--user` / `--no-block` / a dedicated unit name / **no `--scope`** / no `PartOf` /
an absolute updater path) and worker ordering (stop → switch → start, with
rejections that can be decided before stopping handled before the stop).

**Tests do not pin systemd's behavior that `systemd-run --user --no-block` starts
the unit in a cgroup separate from the caller.** Testing it requires sharing the
host user-systemd instance, which has the active runner. Therefore **an operator
checks once on real hardware**, but **never use the production runner**; a
disposable probe unit is sufficient.

```sh
# 1. Create a caller unit and queue a worker from inside it in the same form as the updater
rm -f "$HOME/kaoiro-selftest.sentinel"
systemd-run --user --unit=kaoiro-selftest-caller \
  --description='kaoiro #229 self-stop probe (caller)' \
  /bin/sh -c 'systemd-run --user --no-block \
      --unit=kaoiro-selftest-worker \
      -- /bin/sh -c "sleep 20; date > $HOME/kaoiro-selftest.sentinel"; \
    sleep 300'

# 2. Confirm that the cgroups of the two units are separate (the key property)
systemctl --user show -p ControlGroup --value kaoiro-selftest-caller.service
systemctl --user show -p ControlGroup --value kaoiro-selftest-worker.service
# -> Must be different values. If identical, stopping the caller would kill the worker too

# 3. Stop the caller (KillMode=control-group kills the caller's cgroup, matching production runner stop mechanism)
systemctl --user stop kaoiro-selftest-caller.service

# 4. Confirm the worker finishes to completion
sleep 25
cat "$HOME/kaoiro-selftest.sentinel"          # Must contain timestamp
systemctl --user show -p Result --value kaoiro-selftest-worker.service
# -> success

# 5. Cleanup
systemctl --user reset-failed kaoiro-selftest-caller.service \
  kaoiro-selftest-worker.service 2>/dev/null || true
rm -f "$HOME/kaoiro-selftest.sentinel"
```

Step (2) proves a separate cgroup and (4) proves completion after stopping the
caller. These are the prerequisites for `kaoiro-runner-update.sh --detach`; the
argv contract tests above ensure it starts in the same form. **Neither the
production runner service nor the `kaoiro-runner-update` unit is touched**, so run
this check at any time.

For hosts with Antigravity enabled, also verify in the live service journal
(`journalctl --user -u kaoiro-runner`) that `runner: antigravity agy version <version>`
is emitted and matches `agy --version`, confirming CLI resolution and version
reporting (`antigravity_cli_version`) succeed without warnings.

## See Also

- [Runner update and rollback](runner-update-and-rollback.md).
- [Runner service isolation](../evidence/deployment/runner-service-isolation.md) -- the dated measurement this procedure produced.
- [Runner install and distribution](runner-install.md#antigravity-presence-check-and-version-reporting).
