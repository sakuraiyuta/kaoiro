---
title: Persona sprite caching in the browser, before and after the cache rule
status: recorded
last_updated: 2026-11-14
---

# Issue 1105 — persona sprite caching in the browser

[Issue 1105](https://github.com/sakuraiyuta/kaoiro/issues/1105) lets browsers
cache versioned sprite images. This record holds two measurements: one on the
base commit before the design (`private, no-store` everywhere), and one on the
implementation commit. The rule itself is in
[persona delivery](../../reference/protocol/persona-delivery.md).

| Measurement | Commit |
|---|---|
| Before the design | `04a4c490ee3bccbbc4c20faadfa0fc27ce549cbb` |
| Acceptance | `9b75c61df760d12643e86f31cdbddacb9e65b9bf` (server code and tests of the change) |

## Method

Each measurement has two stages, run in isolated Linux containers without
network access. The tools were throwaway and are not committed.

1. **Real endpoint headers.** A scratch ExUnit test starts the real endpoint on
   a Bandit listener (the pattern of `device_flow_test.exs`), mints cookies
   through `POST /session/new`, and records every response header for the
   cases in the tables below, using the bundled `ao` pack. Elixir 1.20.1,
   Erlang/OTP 29 (erts 17.0.2), container image
   `sha256:431e47077ade55b2acf621898f653451f542de12a51ffe538c3c5e69b8fbccc9`.
   Result: 1 passed, exit 0, both times.
2. **Browser behaviour.** A scratch Node HTTP server replays the stage-1 header
   lists of the authenticated 200 image response and of the anonymous 401,
   dropping only `date`, `content-length` and `x-request-id`. A `/login`
   response sets an `HttpOnly; SameSite=Lax` session cookie; image requests
   without a valid session get the replayed 401. Chromium headless shell
   151.0.7922.34 (Playwright 1.62.1), persistent profile with its on-disk HTTP
   cache, one fresh profile per scenario, container image
   `sha256:4f8d8eccf4e67b2473f8bc1fa9ac744a7d88d3a2f8eae827e12a94a2008687c8`.
   The server counts every request that reaches it; Chrome DevTools Protocol
   `Network.*` events classify cache use. The page shows sprites with one
   `<img>`, either swapping its `src` or replacing the element, which is what
   `{#key display.shown}` around `PersonaFace` does in `AgentCard.svelte`.
   Result: `{"result":"pass","runs":18,"failures":0}`, exit 0, both times.

Stage-2 inputs:

- The header file is the stage-1 output lines tagged `HDR1105`, with the tag
  removed: `grep '^HDR1105 ' <stage-1 log> | sed 's/^HDR1105 //'`. 12 lines.
  sha256 before the design (regenerated from the same log with the same
  command after the run): `87622daad1be42299b1ac5b58ff61c1e67ec91ae519db0c37f7b6e7b594582de`.
  sha256 for the acceptance run:
  `5c41d808f9892cfa279d9738be721720a21d819a43cb284cc5a984fa5ffe4aaf`.
- Images: `unzip -j` of `sprites/idle.png`, `sprites/thinking.png` and
  `sprites/error.png` from `server/priv/persona-packs/ao-1.0.2.zip` (sha256
  `4c780bd2f1e1e6c5a42511d3b9b68da0320113fcc7e834130983514cc9e69a6e`):
  `6490f4eedf7e0b8d55d30ecd7e825c0ecc390f4a273af8df33bf2bb51c1895b2`,
  `0b260bfcd4e1a3c9a6b67eeb8f19e0b59c97bde849b9a5fd1810e94fcb6500bd`,
  `5145f0f460f1962ccde8233c6a6337f2a0ef26e2d0e1d1d0e6451a22aa90e9a5`.
  The emitted `v` of `idle.png`, `6490f4eedf7e`, is the prefix of its SHA-256.

Raw logs are kept outside the repository with the implementation report.
sha256: before the design, stage 1
`21754ee8f0b3a92f478f27f43dc1dfcaafdc5e7f669406f24d124a7adcfaf941`, stage 2
`b7560dff67ee8b983770e44f556819aeccf64e210d0e2482a7d9b020be4f85e8`;
acceptance, stage 1
`5cdc69084dddc5dacb111492c2f8503f75489057ea06bfdbcff31fef4754e046`, stage 2
`3f9a5ecd7f771a88287e1268a2dacbae257f866195e84d047e68c982141ba107`.

## Stage 1: headers from the real endpoint

URL under test: `/personas/ao/idle.png?v=6490f4eedf7e&auth=1` (the manifest
URL). No response in either measurement carried `ETag`, `Last-Modified` or
`Set-Cookie`.

| Case | Status | Before the design | Acceptance |
|---|---|---|---|
| `GET /api/personas` (operator) | 200 | `private, no-store` | `private, no-store` |
| GET manifest URL (operator) | 200, 130886 B | `private, no-store` | `private, max-age=31536000, immutable` |
| GET bare URL (operator) | 200 | `private, no-store` | `private, no-store` |
| GET `?v=wronghash000` (operator) | 200 | `private, no-store` | `private, no-store` |
| HEAD manifest URL (operator) | 200, 0 B body, `content-length: 130886` | `private, no-store` | `private, max-age=31536000, immutable` |
| GET manifest URL with `If-None-Match: *` and `If-Modified-Since` | 200, full body | `private, no-store` | `private, max-age=31536000, immutable` |
| GET unknown file (operator) | 404 | `private, no-store` | `private, no-store` |
| GET and HEAD manifest URL, anonymous | 401 | `private, no-store` | `private, no-store` |
| GET manifest URL, viewer outside the allowed packs | 404 | `private, no-store` | `private, no-store` |
| GET manifest URL, `Authorization: Bearer abc` | 401, `WWW-Authenticate … invalid_token` | `private, no-store` | `private, no-store` |
| GET manifest URL, `Authorization: Bearer !!` | 400, `WWW-Authenticate … invalid_request` | `private, no-store` | `private, no-store` |

## Stage 2: browser behaviour

Display sequence A, B, A, B, A (A = idle, B = thinking). Each cell counts the
requests that reached the server for displays 3 to 5 (the repeats).

Before the design, the "no-store" column replays the captured headers and the
"long cache" column replaces only `Cache-Control` with
`private, max-age=31536000, immutable`. In the acceptance run, the "long cache"
column replays the captured headers unchanged, and the "no-store" column
replaces `Cache-Control` with `private, no-store` as the negative control.
Both measurements gave the same counts.

| Scenario | DOM pattern | no-store | long cache |
|---|---|---|---|
| S1 | same `<img>`, `src` swapped | 3/3 re-downloaded | 0/3 (no network event) |
| S2 | new `<img>` per display | 0/3 | 0/3 |
| S2g | as S2, forced GC (`HeapProfiler.collectGarbage` twice) before each display | 3/3 re-downloaded | 0/3 (`fromDiskCache`) |
| S2w | as S2, 20 s idle before each display | 1/3 re-downloaded (display 3) | 0/3 (display 3 `fromDiskCache`) |
| S3 | as S1, forced GC before each display | 3/3 re-downloaded | 0/3 (`fromDiskCache`) |
| S4 | page reload, then A and B | 2/2 re-downloaded | 0/2 |

S4 rests on 0 server hits and `Network.requestServedFromCache`; the step also
emits a `responseReceived` with `fromDiskCache: false`, which is not used.

Other scenarios, same results in both measurements:

| Scenario | no-store | long cache |
|---|---|---|
| S5: the server swaps `idle.png` for other bytes; show the new `?v=` URL, then the old URL again | New URL fetched and shows the new pixels (canvas digest equal to the swapped image). Old URL fetched again and shows the new bytes | New URL fetched and shows the new pixels. Old URL shows the old pixels from cache, 0 requests |
| S6: the session is revoked server-side after A and B were shown; show A, then an uncached URL | A: 401, image error. Uncached: 401 | A: shown from cache, 0 requests (accepted residual). Uncached: 401 |
| S7: fresh profile without cookie, show A | 401 | 401 |

Controls: every first display reached the server, so the counter registers
hits. 0 requests carried `If-None-Match` or `If-Modified-Since`.

## Limits

- The real dashboard bundle and the real Phoenix server were not run in one
  browser session. Stage 2 replays the real headers and mimics the DOM
  operation; it does not run Svelte or the channel, and the scratch server does
  not implement the version rule (S5 swaps bytes in the scratch server; the
  server-side rule is covered by the ExUnit tests of the change).
- Full Chrome aborted at start in the container (SIGABRT, no D-Bus), so only
  the headless shell was measured. Firefox and Safari were not measured.
- Loopback HTTP only: HTTPS, `Secure` cookies and disk-cache eviction under
  pressure were not measured. RFC 8246 says clients should ignore `immutable`
  over non-HTTPS; Chromium cached over loopback HTTP anyway.
- Bearer clients were not measured in a browser; they cache only if they keep
  an HTTP cache.
