---
title: Deployment troubleshooting
description: Recovering a server container that failed to start after a host reboot in a direct-VPN publish-address deployment.
status: accepted
last_updated: 2026-09-19
related: [deployment]
---

# Deployment troubleshooting

### Container does not start after a reboot

**Symptom.** The server container is not running after a host reboot.

**Diagnosis.** Inspect the existing container's recorded error:

```sh
docker inspect --format '{{.State.Error}}' <container>
```

If it reports `cannot assign requested address`, check whether
`KAOIRO_PUBLISH_IP` is present on a host interface. A VPN address that is absent
while Docker starts causes the published port bind to fail.

**Remedy.** Install and verify the VPN ordering drop-in from [1.5](network-and-login.md#boot-order-for-a-vpn-publish-address), then start the existing
container with `docker start <container>` once the publish address is present.
Do not treat `docker compose up --no-build` as the general recovery command: a
prepared `latest` tag can point to a newer image, while the existing container
identifies the known deployment state.

## See Also

- [Multi-host deployment architecture](../architecture/deployment.md).
- [Server update and rollback](server-update-and-rollback.md#44-failure-handling).
- [Runner update and rollback](runner-update-and-rollback.md).
