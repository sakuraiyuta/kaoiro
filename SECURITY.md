# Security Policy

## Status

kaoiro is a research prototype maintained by a single developer. There
is no security SLA: reports are read on a best-effort basis, and fixes
may take time or may not arrive. Deploy it with that in mind (see
"What an operator credential means" below).

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting ("Report a
vulnerability" under the repository's Security tab) rather than a
public issue, so that a fix can land before details become public.
A report with a reproduction path is far more likely to be addressed.
There is no guaranteed response time.

## What an operator credential means

Read this before deploying kaoiro anywhere.

The kaoiro client sends instructions and permission approvals to
connected agents. By design, **anyone holding an operator token or an
operator-role OAuth identity can make agents read and write files and
run commands on the machines where those agents run** — the impact is
equivalent to remote command execution on those hosts, bounded only by
each wrapper's local `allowedTools` ceiling (which the server and
client cannot widen).

Consequently:

- Treat an operator token like an SSH key to every agent host.
- Keep operator and viewer tokens separate; distribute operator
  credentials minimally.
- Terminate TLS in front of the server. Plain HTTP is supported only
  for VPN-internal deployments (see
  [docs/specs/deployment.md](docs/specs/deployment.md)).
- Token auth fails closed when `KAOIRO_CLIENT_TOKENS` is unset, and
  OAuth login rejects identities missing from the allow-list — keep
  that allow-list minimal, since it is what bounds who can hold the
  operator role.

## Known limitations

- No audit log of operator instructions yet.
- No masking of secrets that may appear in tool inputs shown to
  operators.
- Dependency updates happen on a best-effort basis.

The full threat model and the mitigations implemented today are
documented in
[docs/specs/threat-model.md](docs/specs/threat-model.md) (Japanese).
