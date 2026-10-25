# Gate 6 record for Codex 0.161.0 (r2): redaction note

`pin-0.161.0-gate6-2026-10-10-r2.md` and `pin-0.161.0-gate6-2026-10-10-r2.json`
in this directory are redacted copies of the Gate 6 measurement that supports
retiring the five pre-571 Codex-state recovery points ([issue #571](https://github.com/sakuraiyuta/kaoiro/issues/571), option B;
recorded in [issue #586](https://github.com/sakuraiyuta/kaoiro/issues/586)).

Only two literal strings were replaced, everywhere they occur. Nothing else
was changed:

| Original | Replaced with | Why |
|---|---|---|
| the operator's home directory | `<home>` | it contains the OS user name |
| the disposable scratch directory of the run, under `/tmp` | `<scratch>` | it names a private working directory |

The private retirement evidence cites the unredacted originals by SHA-256.
Those originals are kept privately, together with the independent review r2
of the record:

| File | SHA-256 of the original |
|---|---|
| `pin-0.161.0-gate6-2026-10-10-r2.md` | `469220590444f85ff6ad99c4f7d6f7098e3446ecd98e71aee2331d257c4e8d96` |
| `pin-0.161.0-gate6-2026-10-10-r2.json` | `68262fcfeb28fd6fccc1bdc579c903558e0a5152e1c5d35a24c1cefbe901bc72` |
| review r2 of the record | `8c2c448ae7eac5c52c87f900558394425aa361ec0f53cb25b461f019bceb0655` |

To check a redacted copy against an original, apply the same two
replacements to the original and compare the bytes.
