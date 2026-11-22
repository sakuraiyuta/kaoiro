---
title: Antigravity 1.5.14 authentication measurements
status: measured
last_updated: 2026-11-22
---

# Antigravity 1.5.14 authentication measurements

These Linux measurements informed the
[runner authentication decision](../../adr/0077-antigravity-authentication.md).
The raw logs are retained until landing and are available on request.

## Conditions and commands

Each case used a fresh HOME and an empty initial environment in a private
user, mount and PID namespace. The real home and user runtime directory were
hidden. The CLI copy was in a read-only directory. The isolation controls
checked absence of the original login and session bus, and that the credential
directory was absent or mounted read-only as appropriate. No credential
contents were inspected by the measurement harness. A dedicated Cloud project
and service account were used. No AI Studio key was supplied.

The help capture recorded the CLI options. The print cases sent one stream-JSON
user message on stdin and closed input. The successful case requested an OK
reply from the flash-lite model. Commands inside the isolated environment:

```sh
agy --help
agy --print "" --input-format stream-json --output-format stream-json \
  --print-timeout 0 --disable-slash-commands --add-dir .
agy models
agy --version
```

| Case | Authentication inputs (variable names only) | Observation |
|---|---|---|
| Isolation, no key / key mounted | None / credential file available | Real user cache and bus hidden in both cases. Key readable only in the second case and not writable. |
| Print controls before M1, M3 and M2 | None | All three required authentication, zero turns, exit 1. |
| M1 flag only | AGY_ADC_AUTH | Authentication required, zero turns, exit 1. |
| M1 Gemini provider in settings | No GEMINI_API_KEY | Diagnostic identified the missing variable, exit 1. |
| M2 file only | GOOGLE_APPLICATION_CREDENTIALS | Authentication required, zero turns, exit 1. |
| M2 ADC | AGY_ADC_AUTH and GOOGLE_APPLICATION_CREDENTIALS | One turn completed with OK on gemini-3.1-flash-lite-preview, exit 0. |
| M3 catalog | Same two ADC markers | 38 entries (29 Gemini, 8 Claude, 1 orchestrator), exit 0. Listing does not establish model access. |
| M3 catalog control | None | Sign-in required, exit 1. |

GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION were absent. The billing
destination was not checked in the console. Credential precedence in a home
containing a personal login was not tested.

## M1b file lookups and connections

In the same empty-credential environment, prefix the version or print command
above with the following trace command. The capture includes the traced
processes and stderr, with secrets redacted before persistence.

```sh
strace -f -qq \
  -e trace=openat,open,connect,newfstatat,stat,access,faccessat2,readlinkat \
  -o /dev/stderr
```

For each saved capture, set `trace` to its file name. This projection emits
one line per matching credential lookup or connection attempt, in order.
It counts connect entries once, including unfinished calls, without counting
their later resumes a second time. Endpoint addresses and per-run paths are
omitted. Network observations cover the traced connect syscall.

```sh
awk '
  /openat\(|open\(|newfstatat\(|stat\(|access\(|readlinkat\(|faccessat2\(/ {
    if (/\/antigravity-oauth-token"/) print "credential ~/.gemini/antigravity-cli/antigravity-oauth-token"
    if (/\/credential-user-scope"/) print "credential ~/.config/antigravity/credential-user-scope"
    if (/\/application_default_credentials\.json"/) print "credential ADC"
  }
  /connect\(/ {
    if (/sa_family=AF_INET,/) print "connect AF_INET"
    else if (/sa_family=AF_INET6,/) print "connect AF_INET6"
    else if (/sun_path="\/var\/run\/nscd\/socket"/) print "connect AF_UNIX nscd"
    else if (/sun_path="[^"]*\/bus"/) print "connect AF_UNIX session bus"
    else print "connect other"
  }
' "$trace"
```

### Version

Full filter output (78 capture lines).

```text
connect AF_UNIX nscd
connect AF_UNIX nscd
```

### Print control

Full filter output (2095 capture lines).

```text
connect AF_UNIX nscd
connect AF_UNIX nscd
connect AF_UNIX nscd
connect AF_UNIX nscd
credential ~/.config/antigravity/credential-user-scope
credential ~/.gemini/antigravity-cli/antigravity-oauth-token
connect AF_INET
connect AF_INET
connect AF_INET6
connect AF_INET6
connect AF_INET6
connect AF_INET6
connect AF_INET6
connect AF_INET6
connect AF_INET6
connect AF_INET6
connect AF_INET
connect AF_INET
connect AF_INET
connect AF_INET
connect AF_INET
connect AF_INET
connect AF_INET
connect AF_INET
connect AF_INET6
connect AF_UNIX nscd
connect AF_UNIX nscd
connect AF_UNIX nscd
connect AF_UNIX nscd
connect AF_UNIX nscd
connect AF_UNIX nscd
connect AF_INET
connect AF_INET
connect AF_INET
connect AF_INET
connect AF_INET
connect AF_INET
connect AF_INET
connect AF_INET
connect AF_INET
connect AF_INET
connect AF_INET6
connect AF_INET6
connect AF_INET6
connect AF_INET6
connect AF_INET6
connect AF_INET6
connect AF_INET6
connect AF_INET6
connect AF_INET6
```

| Capture | OAuth token lookup | User-scope credential lookup | Default ADC lookup | IPv4 connect | IPv6 connect | nscd connect | Session bus connect | Other connect |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Version | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| Print control | 1 | 1 | 0 | 20 | 18 | 10 | 0 | 0 |

The print control exercises both personal-credential paths and both IP
families with the same collector and filter. Neither run exercises a positive
default ADC lookup or a session bus connection. Those zero counts describe
these captures only.
