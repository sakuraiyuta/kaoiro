# Third-Party Licenses

kaoiro's own source is MIT-licensed (see [LICENSE](LICENSE)). This file
records third-party dependencies whose license requires notice beyond a
standard permissive license, plus a summary of the full dependency
license distribution across the project's 4 dependency roots
(`wrapper/` + `runner/` share one pnpm lockfile, `dashboard/` is an
independent pnpm root, `server/` is Elixir/mix). No GPL or AGPL
dependency was found in any root.

## LGPL-3.0-or-later

- `@img/sharp-libvips-linux-x64@1.3.1`
- `@img/sharp-libvips-linuxmusl-x64@1.3.1`

Pulled transitively by `sharp` (itself Apache-2.0, used by
`wrapper/claude-code` and `runner`) as a platform-specific prebuilt
binary of [libvips](https://github.com/libvips/libvips). LGPL-3.0 does
not require kaoiro's own code to be LGPL-licensed — it requires that the
covered library component stay replaceable/re-linkable and that its
license text and notices are preserved when redistributed (LGPL-3.0
§4). This notice, together with the license text below, satisfies that
requirement for an application that only links against/bundles the
library unmodified.

Full license text: <https://www.gnu.org/licenses/lgpl-3.0.txt>
Upstream: <https://github.com/lovell/sharp-libvips>

## MPL-2.0 (dashboard/ only)

- `lightningcss@1.32.0`
- `lightningcss-linux-x64-gnu@1.32.0`
- `lightningcss-linux-x64-musl@1.32.0`
- `dompurify@3.4.10` — dual-licensed `(MPL-2.0 OR Apache-2.0)`; kaoiro
  relies on the Apache-2.0 option

MPL-2.0 is a file-level weak copyleft: it applies only to modifications
made to the MPL-covered files themselves, not to the surrounding
application. kaoiro does not modify the source of any of the packages
above, so no MPL obligation propagates to kaoiro's own code.

Full license text: <https://www.mozilla.org/en-US/MPL/2.0/>

## Proprietary dependency (not open source)

- `@anthropic-ai/claude-agent-sdk@0.3.228` (and its platform packages
  `-linux-x64`, `-linux-x64-musl`)

Licensed under Anthropic's own terms (see the package's own
`LICENSE.md`), not an OSI-approved open-source license and not covered
by this repository's MIT license. See
<https://code.claude.com/docs/en/legal-and-compliance>. `wrapper/claude-code`
depends on it to host Claude Code as an agent backend; the dependency
does not change the license of kaoiro's own source (see also
[README.md](README.md#license)).

## Everything else

| Root | MIT | Apache-2.0 | ISC | BSD-2/3-Clause | Other permissive | Resolved from "Unknown" |
|---|---|---|---|---|---|---|
| `wrapper/` + `runner/` | 156 | 13 | 10 | 6 | `(MIT AND Zlib)` x1, `0BSD` x1, `Unlicense` x1 | 3 `@anthropic-ai/claude-agent-sdk` packages → proprietary (above) |
| `dashboard/` | 156 | 10 | 35 | 10 | `MIT-0` x2, `BlueOak-1.0.0` x1, `CC0-1.0` x1, `Unlicense` x1 | `khroma@2.1.0` (license field missing in `package.json`) → MIT, confirmed by reading its bundled `LICENSE` file directly |
| `server/` (mix) | 10 | 13 | – | – | – | – |

`wrapper/` and `runner/` share a single pnpm lockfile and resolve to an
identical dependency closure (`runner` depends on the full `wrapper`
workspace), so they are reported together.

## Audit method

- `wrapper/` + `runner/`: `pnpm licenses list --json --filter @kaoiro/wrapper-core --filter @kaoiro/agent-common --filter @kaoiro/claude-code --filter @kaoiro/codex`, cross-checked with `pnpm --filter "@kaoiro/runner..." licenses list --json` (the `...` suffix is required — without it, dependencies pulled in through workspace-internal packages are undercounted)
- `dashboard/`: `cd dashboard && pnpm licenses list --json`
- `server/`: no `mix licenses` task exists in this Elixir/mix toolchain; dependency list from `mix deps`, then `curl -sS https://hex.pm/api/packages/<pkg>` per package for the `meta.licenses` field
- Every `Unknown`/missing-license result above was resolved by reading the package's own `LICENSE`/`LICENSE.md` file directly, never inferred from a registry field alone

Audited 2026-08-23 against the `develop` branch. The dependency
lockfiles (`pnpm-lock.yaml`, `dashboard/pnpm-lock.yaml`, `server/mix.lock`)
carry no changes between the audited commit and this repository's state
at release, so the figures above remain current.
