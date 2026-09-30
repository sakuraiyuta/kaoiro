---
title: "Codex home for production"
status: implemented
last_updated: 2026-09-30
---

# Codex home for production

Production Codex wrappers run against a dedicated `CODEX_HOME`, injected through
`runner.env`, so that the host's global `codex` CLI cannot migrate their state
or open the concurrent-initialize race of
[issue #411](https://github.com/sakuraiyuta/kaoiro/issues/411) against it
(operator decision, [issue #454](https://github.com/sakuraiyuta/kaoiro/issues/454)).
The contract is in the [runner reference](../reference/configuration/runner.md#codex-home).

Status: the reader fix (the runner and the wrappers honor `CODEX_HOME`) ships
first and changes nothing while the variable is unset. The cutover below is an
operator action, done after the reader fix is deployed.

## What the setting does

- `CODEX_HOME` unset or empty: `~/.codex`, exactly as before.
- `CODEX_HOME=<absolute dir>` in `runner.env`: the runner's resume scan, every
  Codex wrapper, the Codex SDK and the `codex app-server` child use that
  directory for `auth.json`, `config.toml`, `sessions/` and the state databases.
- The directory must exist. Codex does not create it and fails fast otherwise
  (`CODEX_HOME points to "<path>", but that path does not exist`). The runner
  checks it and refuses Codex launches with a reason instead of letting every
  wrapper crash-loop; see
  [troubleshooting](deployment-troubleshooting.md#codex-launches-are-refused-codex_home-is-unusable).
- Do not put it under `/tmp`: Codex refuses to create its helper binaries there.
- Do not `export CODEX_HOME` from a shell profile. The global `codex` CLI would
  then use the production home and the separation is lost.

## Path

`${XDG_DATA_HOME:-$HOME/.local/share}/kaoiro/codex-home` (macOS:
`~/Library/Application Support/kaoiro/codex-home`), next to the runner install
root. There is no default in code: write the fully expanded absolute path into
`runner.env` and record it.

## Operator login (needs the operator)

The dedicated home starts without credentials. Log in with the pinned binary, so
that only the pinned version ever touches the home. Use `CODEX_HOME` inline for
each command:

```sh
H="${XDG_DATA_HOME:-$HOME/.local/share}/kaoiro/codex-home"
mkdir -p "$H" && chmod 700 "$H"
BIN=$(find "$HOME/.local/share/kaoiro/current/" -type f -name codex \
  -path '*/vendor/*')
printf '%s\n' "$BIN" | wc -l          # must print 1; stop otherwise
CODEX_HOME="$H" "$BIN" --version      # expect the pinned version
CODEX_HOME="$H" "$BIN" login --device-auth
CODEX_HOME="$H" "$BIN" login status   # expect: Logged in using ChatGPT
```

- `mkdir` is required. `login status` prints the login mode, not a token.
- `--device-auth` prints a URL and a code to enter in a browser on any device;
  the default `login` uses a browser flow on the host.
- `auth.json` is never copied from `~/.codex`: two logins are independent
  sessions, and a copy would share refresh-token state.
- Log in before the runner restart. With no credentials the runner cannot read
  the auth mode and publishes an empty Codex model catalog; setting
  `codex.auth_mode` in `runner.config.json` removes that ordering dependence.

## What the new home contains

| Item | Decision |
| --- | --- |
| `auth.json` | Created by the login above. |
| `AGENTS.md`, `agents/`, `model-profiles/`, `hooks/` | Symlinks into the operator's ai-settings checkout, as in `~/.codex`, so the peers keep their global instructions. |
| `config.toml` | Written by hand, minimal: `model`, `model_reasoning_effort`, `project_doc_fallback_filenames`, and `trust_level` for the directories the peers run in. Not copied from `~/.codex`. |
| `[[hooks.*]]` | See "Hooks". |
| `rules/default.rules` | Not carried: it holds the operator's own interactive approvals. |
| `sessions/`, `state_5.sqlite`, `thread_history_1.sqlite`, other databases, caches, plugins, history | Not carried. Created fresh by the pinned binary. |

### Hooks

The model-profile hook (`ai-settings/codex/hooks/model-profile.sh`) behaves as
follows in a new home (probe P2, pinned 0.156.1, issue #454):

- A hook without a matching `[hooks.state]` trust entry is skipped silently.
  The trust key is `<absolute path of config.toml>:<event>:0:0`; the `sha256:`
  value of an existing entry works when re-keyed to the new `config.toml` path.
- The script reads `$HOME/.codex/model-profiles`, whatever `CODEX_HOME` is, so
  carrying it unchanged keeps a dependency on the old home's symlink.
- The hook process sees `CODEX_HOME`, so the script can follow it
  (`${CODEX_HOME:-$HOME/.codex}/model-profiles`) without changing the hook
  definition or its trust.

Whether to carry the hook, and whether to change that line in ai-settings, is
recorded in issue #454. A wrong or missing trust entry fails silently, so the
cutover checks that the injection happened (below).

## Cutover

1. Deploy the reader fix through a normal runner update and confirm that
   behavior is unchanged with `CODEX_HOME` unset.
2. Operator: create the home and log in (above); create the symlinks and the
   minimal `config.toml`; add `CODEX_HOME=<absolute path>` to `runner.env`
   (mode 0600).
3. Pick an idle moment: no in-flight Codex turns and no queued deliveries. Note
   the Codex session ids and hand open items over to issues or the worklog.
4. Restart the runner (`systemctl --user restart kaoiro-runner`). The journal
   shows `runner: codex home=<path>`; each Codex wrapper logs `codex: home=<path>`.
   Claude and Antigravity agents restore as usual. Codex restores end with
   `session_not_found`, because the new home has no sessions.
5. Start the Codex peers as new sessions from the dashboard, one first. After its
   first good turn check the rate-limit windows, one permission decision, and
   (if the hook is carried) that `~/.cache/codex-cc/.codex-cc-model-injected-<session>`
   exists. Then start the others.
6. Verify the separation (below).

## Rollback

Remove `CODEX_HOME` from `runner.env` and restart the runner. The wrappers use
`~/.codex` again and the old threads resume there. Threads created in the
dedicated home are not resumable in `~/.codex`. The dedicated home can stay or be
deleted. Rolling back restores the shared-home exposure described above.

## Verify that the global CLI is separate

1. Each Codex wrapper: `tr '\0' '\n' < /proc/<pid>/environ | grep '^CODEX_HOME='`
   shows the dedicated path (print only that line).
2. No production Codex process holds files in `~/.codex`: `ls -l /proc/<pid>/fd`
   for each wrapper and `codex` child shows no `/.codex/` path and shows
   `state_5.sqlite` under the dedicated home.
3. The dedicated home's `_sqlx_migrations` count equals the pin's, while
   `~/.codex` keeps its own count, and `~/.codex/state_5.sqlite-wal` does not
   change while no global CLI runs.
4. `CODEX_HOME=<dedicated> <pinned> login status` and the global `codex login
   status` are independent.
5. Control: run the global CLI once against `~/.codex` and confirm that checks 2
   and 3 notice it.
