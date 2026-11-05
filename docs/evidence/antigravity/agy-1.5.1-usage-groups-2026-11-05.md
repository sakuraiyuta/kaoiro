---
title: Antigravity 1.5.1 quota groups
description: Sanitized structural observations of three quota groups and their model association.
status: accepted
last_updated: 2026-11-06
---

# Antigravity 1.5.1 quota groups

Observed on 2026-11-05 UTC with `agy` 1.5.1, using a disposable working
directory without resuming a conversation:

```sh
agy -p /usage --output-format json
agy models
```

The retained measurement is normalized, not a verbatim CLI response. The
observer (the director) directly confirmed `command.name: "usage"` and
`command.data.groups` in the original response before normalization. The
retained record contains `status: "SUCCESS"`, `num_turns: 0`, and zero in all
reported token counters. This does not establish an absence of network traffic,
support-process activity or all possible account side effects.

| Group | Exact bucket id | Vendor window |
| --- | --- | --- |
| Gemini Models | `gemini-weekly` | `weekly` |
| Gemini Models | `gemini-5h` | `5h` |
| Claude and GPT models | `3p-weekly` | `weekly` |
| Claude and GPT models | `3p-5h` | `5h` |
| Gemini 4 Argon | `gemini-argon-wtu-weekly` | `weekly` |

Each captured bucket has string `id`, string `window`, finite numeric
`remaining_fraction` and string `reset_time` containing a parseable timestamp.
Argon has one weekly bucket and no five-hour bucket in this observation.

The model catalog reports these exact slugs and display-name families; braces
below enumerate the alternatives and are not literal CLI syntax:

| Slugs | Display-name family |
| --- | --- |
| `gemini-4-argon-{medium,high,low}` | Gemini 4 Argon |
| `gemini-3.8-flash-{high,medium,low}` | Gemini 3.8 Flash |
| `claude-opus-5-5-{low,medium,high}` | Claude Opus 5.5 |
| `claude-sonnet-5-5-{low,medium,high}` | Claude Sonnet 5.5 |
| `gpt-oss-120b-medium` | GPT-OSS 120B |

Group descriptions associate Gemini Flash/Pro with Gemini and Claude
Opus/Sonnet/GPT-OSS with the third-party group. Argon's group name, bucket id
and model names support its association. The operator and director additionally
observed Argon's remaining quota decrease after an Argon turn while the ordinary
Gemini weekly reading stayed unchanged. This is observation plus inference,
not a controlled experiment excluding other shared-account consumers. There
is no machine-readable model-to-bucket association in the retained response.
The runtime selects exact bucket ids/windows and does not parse these names
or descriptions. The catalog examples do not restrict existing Gemini/Claude/GPT
prefix classification to these 13 slugs.

The Argon description distinguishes separate quota on paid Pro plans from
higher quota included in a larger Gemini bucket on Ultra plans. This does not
measure other accounts' bucket presence or establish cross-plan arbitration.
A missing selected Argon bucket never falls back to an ordinary Gemini bucket;
the existing same-group last-good/failure policy applies.

Only `gemini-4-argon-` is specially recognized; future or bare Argon naming needs
new evidence and a mapping change. Model membership changes that preserve the
same ids cannot be detected from this response's structure alone.

No account identifiers, actual quota fractions/deadlines, persona names,
credentials or environment-specific paths are retained here. Test fixtures
use explicitly synthetic values in the observed envelope structure.
