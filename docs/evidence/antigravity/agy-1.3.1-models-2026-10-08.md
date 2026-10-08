---
title: Antigravity CLI 1.3.1 model catalog baseline and effort measurements
status: measured
last_updated: 2026-10-08
---

# Antigravity CLI 1.3.1 model catalog baseline and effort measurements

Target: [issue #534](https://github.com/sakuraiyuta/kaoiro/issues/534), runtime/test
commit for Antigravity 1.3.1 baseline on `issue-534-agy-1-3-1`.
Host: Linux x64, Node 22.23.3, pnpm 10.20.0.
The installed CLI executable (`/home/yuta/.local/bin/agy`) reports `1.3.1`.

## 1. Raw CLI model catalog output

The baseline was captured using the installed production CLI:
```bash
agy models
```
Output format: tab-separated lines (`<model_value>\t<display_name>`), preceded on interactive TTY by a progress spinner that is omitted or cleanly separable on piped stdout.

Raw captured stdout (18 rows) is recorded in [`agy-1.3.1-models.stdout`](agy-1.3.1-models.stdout):

| Model value | Display name | Family |
|---|---|---|
| `gemini-3.8-flash-high` | Gemini 3.8 Flash (High) | Gemini 3.8 Flash |
| `gemini-3.8-flash-medium` | Gemini 3.8 Flash (Medium) | Gemini 3.8 Flash |
| `gemini-3.8-flash-low` | Gemini 3.8 Flash (Low) | Gemini 3.8 Flash |
| `gemini-3.7-flash-high` | Gemini 3.7 Flash (High) | Gemini 3.7 Flash |
| `gemini-3.7-flash-medium` | Gemini 3.7 Flash (Medium) | Gemini 3.7 Flash |
| `gemini-3.7-flash-low` | Gemini 3.7 Flash (Low) | Gemini 3.7 Flash |
| `gemini-3.6-flash-high` | Gemini 3.6 Flash (High) | Gemini 3.6 Flash |
| `gemini-3.6-flash-medium` | Gemini 3.6 Flash (Medium) | Gemini 3.6 Flash |
| `gemini-3.6-flash-low` | Gemini 3.6 Flash (Low) | Gemini 3.6 Flash |
| `gemini-3.1-pro-high` | Gemini 3.1 Pro (High) | Gemini 3.1 Pro |
| `gemini-3.1-pro-low` | Gemini 3.1 Pro (Low) | Gemini 3.1 Pro |
| `claude-opus-5-5-low` | Claude Opus 5.5 (Low) | Claude Opus 5.5 |
| `claude-opus-5-5-medium` | Claude Opus 5.5 (Medium) | Claude Opus 5.5 |
| `claude-opus-5-5-high` | Claude Opus 5.5 (High) | Claude Opus 5.5 |
| `claude-sonnet-5-5-low` | Claude Sonnet 5.5 (Low) | Claude Sonnet 5.5 |
| `claude-sonnet-5-5-medium` | Claude Sonnet 5.5 (Medium) | Claude Sonnet 5.5 |
| `claude-sonnet-5-5-high` | Claude Sonnet 5.5 (High) | Claude Sonnet 5.5 |
| `gpt-oss-120b-medium` | GPT-OSS 120B (Medium) | GPT-OSS 120B |

Historical catalog baseline notes:
- The historical measurements from 1.1.26 (captured in `docs/architecture/antigravity-adapter.md` and `docs/reference/engines/antigravity-events.md`) remain preserved as historical records of that earlier release.
- Compared with 1.1.26, obsolete model offerings (such as legacy `gemini-2.5-*` and older experimental tiers) have rolled off, and current generation offerings (`gemini-3.8-*`, `claude-*-5-5-*`) are now native offerings.

## 2. Relationship with the static fallback snapshot

In `wrapper/antigravity/src/catalog_snapshot.ts`, `antigravityCatalogSnapshot` provides the offline fallback catalog used when `agy models` cannot be invoked at runtime:

1. **Account default row**: The first entry is the fixed synthetic entry `{ value: "antigravity-default", display_name: "Antigravity (Account default)" }`.
2. **Parsed CLI models**: The remaining 18 entries are identical in value, display name, and order to the output of `parseAgyModelsOutput` on the raw 18-row output of `agy models` above (total 19 entries in `antigravityCatalogSnapshot`).
3. **Verification**: `wrapper/antigravity/test/catalog.test.ts` and `runner/test/config.test.ts` assert this exact 19-entry structure and ordering.

## 3. CLI effort flag: advertised options vs effective behavior

Invoking `agy --help` on CLI 1.3.1 advertises the `--effort` option as:
```text
  --effort                        Reasoning effort for the current CLI session (low|medium|high|xhigh|max)
```

**Distinction between advertised CLI flags and verified runtime semantics**:
- **Advertised options**: The CLI help screen lists five effort levels (`low`, `medium`, `high`, `xhigh`, `max`).
- **Effective semantics**: Whether all five levels produce measurably distinct reasoning token budgets or altered model behavior across every model family (e.g. Gemini vs Claude vs GPT-OSS) has **not been independently benchmarked**.
- **kaoiro handling**: kaoiro registers the advertised 5-level enum in its schema and allows valid values to be accepted without rejection, while launch effort selection UI (picker in LaunchDialog) remains an out-of-scope follow-up candidate per director decision.
