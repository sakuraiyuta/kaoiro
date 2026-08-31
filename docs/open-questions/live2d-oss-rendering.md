---
title: Investigation of Live2D-Like OSS Rendering (Adding Motion to Standing Illustrations)
description: Comparison of Live2D-like OSS candidates for adding idle motion to standing illustrations (license, maturity, Web integration, and whether a single image can be reused), with a recommendation on adoption. Adoption is decided separately (issue #20).
status: open
urgency: low
blocks: []
opened: 2026-06-15
decided: null
---

## 背景

Current persona rendering switches between static expression variants ([ADR-0004](../adr/0004-client-rendering-staged.md)).
Because adding motion to standing illustrations is desired (low priority),
investigate Live2D-like OSS as an option for the next stage. ADR-0004 records
the investigation itself as a future task, and this file is its answer. Decide
on adoption separately based on the investigation results (issue #20).

Investigation scope (confirmed by the user on 2026-06-15):

- Motion range: centered on **idle motion** (blinking, breathing, and slight
  swaying). Evaluate lip-sync and state-linked expression changes only for
  whether each candidate supports them as "room for future expansion."
- Assets: **prioritize reusing existing single-image PNGs** ([personas.md](../specs/personas.md)'s
  transparent PNGs with non-separated parts). Explicitly note candidates that
  require recreating separated parts as having "high asset creation cost."

## 選択肢(候補比較)

| Candidate | License | Maturity | Web integration | Single-image reuse | idle | Lip-sync (future) |
|------|-----------|--------|-----------|-----------|------|---------------------|
| 1. PixiJS mesh warp (custom) | MIT (pure OSS) | PixiJS is mature; custom implementation is new | ◎ | ◎ | ◎ | ✕ |
| 2. Inochi2D / Inox2D | BSD-2 (pure OSS) | Core is practical. Web Inox2D is a **prototype, "not recommended for production"** | △ (WebGL/WASM examples exist; experimental stage) | ✕ (INP/INX separated-parts rig required) | ◎ | ◎ |
| 3. Rive | MIT for runtime/renderer | Mature (adopted by Spotify/Duolingo and others) | ◎ (.riv runs persistently offline) | △ (image import → manual rig required) | ◎ | ◎ |
| 4. Live2D Cubism (+ pixi-live2d-display) | **Non-OSS** (proprietary Cubism Core; wrapper is MIT) | Most mature; largest ecosystem | ◎ | ✕ (PSD separated-parts rig required) | ◎ | ◎ |
| 5. Pre-generated AI single-image animation | OSS pipeline (ComfyUI, etc.) | Variable quality; face-centered | ◎ (play pre-generated webm/sprites) | ◎ | ◯ (pre-generated loop) | △ |

Additional candidates excluded after consideration:

- **Synfig / Enve**: General-purpose 2D animation production; not for
  real-time Web puppets.
- **Spine**: High quality, but outside the requirements because it is
  commercial and non-OSS.
- **DragonBones**: Once free, but maintenance has stalled, so new adoption is
  not recommended.

## 影響

- ADR-0004 has already decided to "make it possible to choose static
  variants/animation/3D per persona when technically possible." Adoption still
  permits **staged introduction per persona** and can coexist with existing
  static-variant rendering (a rendering-type field is needed on persona —
  [ADR-0003](../adr/0003-persona-identity-persistence.md) / ADR-0004).
- [non-goals.md](../specs/non-goals.md) puts "advanced animation/3D rendering"
  out of scope. This issue is **not an immediate removal of that non-goal**;
  it evaluates next-stage options limited to lightweight idle motion (issue #20
  explicitly lists "immediate removal of the non-goal" outside its scope).
- If reuse of a single image is prioritized, full rigging engines (candidates
  2/4) incur the asset cost of splitting and re-rigging each persona into
  layers. This would require recreating the current 21 images (3 personas × 7
  states), which is heavy for a low-priority task.

## 判断材料

### Key points by candidate (confirmed from primary sources)

1. **PixiJS mesh warp (custom)** — A lightweight technique that divides a
   single-image PNG into a grid mesh and applies sine displacement to vertices
   to express breathing, swaying, and subtle parallax. It most directly fits
   the scope (single image + idle). Blinking is not possible with a single
   image alone (there is no eyelid layer), but it can be achieved by **generating
   one closed-eye idle variant and cross-fading**, reusing the existing ComfyUI
   i2i mass-production flow ([personas.md](../specs/personas.md)). Dependencies
   are minimal and OSS purity is highest, but implementation is custom and
   expressiveness is inferior to a full rig (no lip-sync).

2. **Inochi2D / Inox2D** — Pure OSS under BSD-2-Clause. A real-time 2D puppet
   system (mesh deformation of layer-separated art). It assumes creating INP/INX
   puppets with Inochi Creator (the editor), so **a single image cannot be
   animated**. The official Rust version, **Inox2D**, has WebGL/WASM rendering
   examples and offers a path to the Web, but its own documentation explicitly
   states that it is in a "prototype state and not recommended for production."
   **Monitor it as a future promotion path when a full rig is needed with pure
   OSS.**

3. **Rive** — The runtime/renderer is MIT, and exported `.riv` files run
   persistently offline and self-hosted (no runtime fee). Web integration is
   excellent through Canvas/WebGL/WASM. On the other hand, **the editor is a
   cloud-only SaaS**, and as of 2026 **exporting requires a paid plan** (Cadet
   from $9/mo). OSS purity (the editor is not public), ongoing cost, and cloud
   authoring are drawbacks. Idle motion can be made with image import plus
   bones/mesh, but manual rigging is required.

4. **Live2D Cubism (+ pixi-live2d-display)** — It has the highest quality and
   largest ecosystem, but is **non-OSS**. pixi-live2d-display itself is an MIT
   wrapper for Web display, but bundling the proprietary **Cubism Core** runtime
   is required. The publishing license exempts individuals/small businesses
   with annual sales under 10 million yen, but an "Expandable Application" that
   lets users add content **requires separate review and a contract even when
   otherwise exempt**; kaoiro (where clients can add personas) may be affected.
   It also has the highest asset cost because a PSD separated-parts rig is
   required. **Not adopted due to the OSS requirement; use as a quality
   benchmark.**

5. **Pre-generated AI single-image animation** (LivePortrait/Thin-Plate-Spline,
   etc.) — **Pre-generate an idle loop offline** from a single image and play
   it as webm/sprites. It can use the available ComfyUI GPU server and needs no
   live rig. However, quality varies and is face-centered; assets become larger
   and it lacks liveness (immediate response to state). **An intermediate
   option when rich idle motion is wanted without a custom rig.**

### 評価軸の重み

Within issue #20's scope (idle-centered + single-image reuse + pure OSS + low
priority), "whether a single image can be reused" and "OSS purity" dominate.
The expressiveness of a full rig (lip-sync, etc.) remains only a future
expansion criterion. With these weights, the full rigs of candidates 2/4 are
eliminated by asset cost, candidate 1 is the strongest, candidate 5 is an
intermediate option, and candidate 3 is an option if its cost is acceptable.

## 暫定方針

1. **The leading candidate for the next rendering tier is candidate 1 (custom
   PixiJS mesh warp)**. It can reuse single-image PNGs as-is, has high OSS
   purity and minimal dependencies, and does not conflict with the non-goal
   (advanced animation/3D). Generate one closed-eye idle variant with ComfyUI
   i2i and supplement blinking with cross-fading.
2. **Monitor Inochi2D (awaiting Inox2D maturity) as the pure-OSS promotion path
   if requirements grow to lip-sync/full expression rigs**.
3. Use Rive only if its cost ($9/mo or more) and cloud authoring are acceptable.
   Do not adopt Live2D due to the OSS requirement (reference benchmark).
4. First run a mesh-warp PoC with one persona such as ao, and evaluate
   legibility and cost in the actual screen. Make the final adoption decision
   separately based on this investigation (as scoped by issue #20).

## 解決時のアクション

- Once the adoption policy is settled, **make it an ADR** (a new ADR
  supplementing ADR-0004, or an update to 0004), and add the persona's
  **rendering-type field** to the plan ([ADR-0003](../adr/0003-persona-identity-persistence.md) / ADR-0004).
- If candidate 1 is adopted, add generation of the **closed-eye idle variant**
  for blinking to the generation workflow in [personas.md](../specs/personas.md).
- Set this file to `decided` and promote it to an ADR (or delete it).

## Sources

Investigation 2026-06-15. Main sources confirmed from primary information:

- Inochi2D license (BSD-2): <https://github.com/Inochi2D/inochi2d/wiki/Legal-Info>
- Inox2D (Rust/WASM, prototype): <https://github.com/Inochi2D/inox2d>,
  <https://docs.inochi2d.com/en/latest/inox2d/about.html>
- Rive runtime MIT: <https://rive.app/docs/runtimes/getting-started>
- Rive pricing (paid export): <https://rive.app/pricing>,
  <https://rive.app/blog/rive-s-new-9-mo-plan>
- pixi-live2d-display (Cubism Core required): <https://github.com/guansss/pixi-live2d-display>
- Live2D SDK publishing license/exemption conditions: <https://www.live2d.com/en/sdk/license/>,
  <https://help.live2d.com/en/sdk/sdk_007/>
