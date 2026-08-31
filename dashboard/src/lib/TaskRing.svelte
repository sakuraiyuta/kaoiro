<script lang="ts">
  import {
    readTaskRingOffset,
    taskRingTopWithDevOffset,
  } from "./taskRingOffset";

  let {
    faceOrbit = false,
    orbitRx,
    orbitRy,
    topOffset,
    count = 1,
  }: {
    /** True when the caller is showing the face-fallback (no persona
     *  sprite resolved), whose orbit needs the smaller default radii
     *  below (S1, クロエ 最終版 2026-08-09) rather than the sprite ones.
     *  Also exposed as the `.face-orbit` class for callers/tests that
     *  key off it directly (AgentCard's existing test contract). */
    faceOrbit?: boolean;
    /** Explicit override for the orbit's horizontal/vertical radius (any
     *  CSS length, including container-query units). Omit to fall back
     *  to the rem defaults below, keyed off `faceOrbit` — AgentCard's
     *  original values (issue #180). AgentDetail (issue #180 follow-up,
     *  2026-08-10) passes `cqw` values instead since its portrait is a
     *  responsive percentage, not a fixed rem. */
    orbitRx?: string;
    orbitRy?: string;
    /** Override for the orbit ellipse's vertical anchor (CSS `top`,
     *  percentage of the containing block's height). Omit to use the
     *  `-2%` default below — AgentCard's original "頭上退避" value,
     *  calibrated for `.card`'s own generous top padding (1.4rem).
     *  AgentDetail's `.portrait` has far less headroom (0.8rem) and no
     *  parent padding above it, so a wide/tall `.portrait` (desktop) can
     *  push the ring past `.portrait` into the page chrome above it —
     *  マスター実機確認 2026-08-10, it reached the "グリッドへ戻る"
     *  button. AgentDetail passes a larger (less negative / positive)
     *  `topOffset` to pull the ellipse's anchor down, trading some
     *  overlap onto the face (explicitly accepted by マスター) for
     *  staying clear of the button above. */
    topOffset?: string;
    /** Active subagent/workflow ROOT count (issue #233, validated design
     *  in issue #233 comment 5450038052). One dot per root, evenly
     *  spaced by ANGLE (not arc length — a workflow's internal children
     *  fan out under one root task and are deliberately not counted
     *  separately; see docs/specs/subagent-tasks.md). `count=1` is
     *  BIT-FOR-BIT the original single-dot geometry (issue #180): theta
     *  = -90deg (12 o'clock), zero phase delay, identical rest-state
     *  translate. */
    count?: number;
  } = $props();

  // Read at component creation so a URL edit plus reload dials the geometry.
  // This temporary knob must also work in the production bundle because the
  // dogfood server serves that bundle; remove it after issue #231's value is
  // chosen. With no knob the existing inline top (or CSS fallback) is kept.
  const taskRingOffset = readTaskRingOffset(
    typeof window === "undefined" ? "" : window.location.search,
  );
  const resolvedTopOffset = $derived(
    taskRingTopWithDevOffset(topOffset, taskRingOffset),
  );

  // Must equal @keyframes task-ring-orbit's `animation` duration below —
  // the phase-delay math needs the real period to convert an angular
  // fraction into a time offset.
  const ORBIT_PERIOD_MS = 2400;

  interface Dot {
    i: number;
    /** Negative animation-delay (ms), so dot i's animation is already
     *  i/count of the way through its cycle at t=0 — the SAME i/count
     *  fraction that spaces `theta` by angle below, so the dots spread
     *  evenly in time exactly as they do in angle. */
    delayMs: number;
    /** True-ellipse rest-state coefficients (cosθ, sinθ) — the position
     *  this dot's OWN base CSS rule (not the animation) resolves to. Not
     *  asserted equal to the animated position at time zero: the
     *  keyframes below interpolate linearly between 30deg steps (12
     *  chords), not the exact ellipse (issue #233 design note — up to
     *  ~1px difference at count=5, rx=2rem — never visible simultaneously
     *  since the animated and reduced-motion-static states don't overlap
     *  in time). */
    x: number;
    y: number;
  }

  // θ = -90deg (12 o'clock, matching the original single-dot anchor) +
  // evenly spaced BY ANGLE around the full ellipse (issue #233 decision:
  // angular spacing, not arc-length spacing, which would bunch dots
  // together on the flatter major axis of a wide ellipse).
  const dots = $derived.by((): Dot[] => {
    const n = Math.max(0, count);
    return Array.from({ length: n }, (_, i) => {
      const thetaDeg = -90 + (360 * i) / n;
      const thetaRad = (thetaDeg * Math.PI) / 180;
      return {
        i,
        delayMs: -((i * ORBIT_PERIOD_MS) / n),
        x: Math.cos(thetaRad),
        y: Math.sin(thetaRad),
      };
    });
  });
</script>

<!-- 頭上リング (issue #180, ADR-0019/0047/0048): サブエージェント/workflow
     稼働の唯一のインジケータ(装飾ではない、N1: クロエ 2026-08-09 — 数値表示
     は無いため、この光点だけが操作者に「今何か動いている」ことを伝える)。
     呼び出し側は {#key state}...{/key} の外に置くこと — state 遷移
     (dissolve remount) の影響を受けず単独で回り続ける。AgentCard /
     AgentDetail 共有(issue #180 follow-up, 2026-08-10 — マスター指摘:
     頭上リングが AgentDetail に無いのはマスター未承認のスコープ外判断
     だったため追加)。

     issue #233 (validated design, issue #233 comment 5450038052):
     count 個の sibling dot を同じ楕円上に描画する。読み上げ対象は
     先頭 dot 1 個だけ(role="img" + count 入り aria-label)にまとめ、
     残りは aria-hidden — 装飾的な sibling を全部 announce すると
     count 分だけ同じ内容が読み上げられてしまうため。数値そのものは
     画面上には出さない(こはく scoping は維持、読み上げ専用)。 -->
{#each dots as dot (dot.i)}
  <span
    class="task-ring"
    class:face-orbit={faceOrbit}
    role={dot.i === 0 ? "img" : undefined}
    aria-hidden={dot.i === 0 ? undefined : "true"}
    aria-label={dot.i === 0
      ? `サブエージェント/workflow実行中 (${count}件)`
      : undefined}
    style:--orbit-rx={orbitRx}
    style:--orbit-ry={orbitRy}
    style:--phase-delay="{dot.delayMs}ms"
    style:--dot-x={dot.x}
    style:--dot-y={dot.y}
    style:top={resolvedTopOffset}
  ></span>
{/each}

<style>
  /* 頭上リング(issue #180, ADR-0019/0047/0048): a single achromatic light
     point orbiting an ellipse above the sprite/face while a
     subagent/workflow task is active under this agent. CSS-only (no
     image assets, per issue scoping). The caller must give this element
     a `position: relative` containing block (AgentCard's `.sprite-slot`,
     AgentDetail's `.portrait`).

     Color (S2, こはく判定 2026-08-09): NOT `var(--tone)` — design.md
     forbids using state-palette saturation for anything but the state
     lamp/badge (彩度を state 以外に使わない). `var(--fg)` (achromatic)
     keeps the read-off rule unambiguous: saturated = state lamp,
     achromatic = subagent activity. Glow mirrors the state lamp's own
     format (`.lamp { box-shadow: 0 0 6px var(--tone) }`) with `--fg`
     substituted.

     Geometry (S1, クロエ 最終版 2026-08-09 — 代案 C, 楕円軌道): a
     CIRCULAR orbit cannot satisfy both constraints at once — the head's
     own vertical extent is ~40% of the sprite slot, but clearing the
     face needs a diameter of ~53%, so a circle's bottom edge always
     dips below the chin regardless of chosen radius (not a tunable
     parameter, a geometric contradiction). An ELLIPSE centered at
     (50%, -2%) with the radii below keeps the dot at-or-above head
     height through every phase of the orbit, reading as an "angel's
     ring" seen in perspective. `offset-path` was rejected (Firefox bug
     1840819, not `@supports`-detectable); animating a parent's
     `scaleY` + child inverse-scale to fake an ellipse from a circular
     orbit was also tried and did not hold up under real rendering.
     `translate`-only, 12 discrete keyframes (4 reads as a diamond, not
     an ellipse) stepping the parametric ellipse x=rx·cosθ, y=ry·sinθ is
     the form that survived. θ runs from -90° (12 o'clock, directly
     above the head) clockwise in 30° steps — CSS's Y-down coordinate
     system makes increasing θ read as clockwise on screen without any
     extra sign flip. `--orbit-rx`/`--orbit-ry` default to the sprite
     radii; `.face-orbit` overrides them for the smaller placeholder face
     (issue #180). A caller may instead override either variable directly
     via inline style (issue #180 follow-up, 2026-08-10) — e.g. with
     container-query units when its containing block is a responsive
     percentage rather than a fixed rem (AgentDetail's `.portrait`).

     `translate`'s two components do double duty in EVERY keyframe below
     (including the base rule and 0%/100%): `-50%` self-centers the dot
     on the (50%, -2%) anchor point (percentages in `translate` resolve
     against the ELEMENT'S OWN box, not the containing block), and the
     `var(--orbit-r*)` term adds the orbit offset for that angle. The
     base rule's own `translate` (used when the animation is not
     running, and — critically — as the effective rest state under
     `prefers-reduced-motion`, whose global app.css rule only shortens
     `animation-duration`/`animation-iteration-count` and sets no
     `animation-fill-mode`) is written to match the 0%/100% keyframes
     EXACTLY (orbit apex, straight up) rather than left to default —
     omitting it would resolve to `translate: none` at rest, dropping
     the `-50%` self-centering term and leaving the dot's top-left
     corner (not its center) planted at the anchor, half a dot-width
     off-position (2nd 追送, クロエ 2026-08-09).

     issue #233: the base rule now reads `--dot-x`/`--dot-y` (this
     dot's own cosθ/sinθ, JS-computed per instance) instead of the
     hardcoded 0/-1 pair a single always-top dot could get away with —
     each dot's rest state must be its OWN point on the ellipse, not
     every dot's. `count=1` resolves `--dot-x: 0` / `--dot-y: -1`,
     reproducing `-50% calc(-50% - var(--orbit-ry))` bit-for-bit.
     `animation-delay` MUST follow the `animation` shorthand below (not
     precede it) — the shorthand resets `animation-delay` to its initial
     value, so a delay declared before it would be silently discarded
     and every dot would stack in phase.

     `top` (S1 最終調整, クロエ承認 2026-08-09): -2%, not the earlier
     12% — 頭上退避(顔に光を乗せない)。12% だと 6 時相(周期の下端)で
     光点が眼鏡フレームのグレアと視覚的に同化し、常時アニメーションの
     一部が顔に乗ってしまう(このリングは唯一の task インジケータで
     装飾ではないため、状態を読む顔の上に重なるのは製品目的と干渉する
     — クロエ判断)。ellipse の縦半径(--orbit-ry)は変えていないので
     下端は依然として頭より上に留まる。この値はボスの実物確認で
     好みが割れれば 1 行で戻せる既定値であり、確定した幾何制約
     (上のコメント参照)ではない。

     issue #231: 軌道の頂点が AgentCard グリッド上端に接して見えるため、
     1920x1080 で頂点を約 8px 下げる。`%` はコンテナ (`.sprite-slot`)
     高さ基準で sprite/face 間でも px 換算値が変わってしまうため、
     `calc(-2% + 8px)` の px 加算項で高さに依存せず一律 8px シフトさせる
     (top が増えると画面下方向に動く CSS の座標系どおり)。8px は過去に
     問題を起こした 12% との差分 (sprite ケースで約 17.9px 相当) の半分
     未満であり、6 時相のグレア同化を再現しない範囲と判断。

     Dev Vite または dogfood の production bundle では
     `?taskRingOffset=N` でこの pixel 項だけを一時的に差し替えられる。
     パラメータ無しの既定値は不変。値の決定後、issue #231 の 2nd delta
     でこの調整穴を削除する。 */
  .task-ring {
    position: absolute;
    left: 50%;
    top: calc(-2% + 8px);
    translate: calc(-50% + var(--orbit-rx) * var(--dot-x, 0))
      calc(-50% + var(--orbit-ry) * var(--dot-y, -1));
    width: 0.34rem;
    height: 0.34rem;
    border-radius: 50%;
    background: var(--fg);
    box-shadow: 0 0 6px var(--fg);
    pointer-events: none;
    --orbit-rx: 2rem;
    --orbit-ry: 0.72rem;
    /* animation-delay MUST come after this shorthand — see the doc
       comment above. */
    animation: task-ring-orbit 2.4s linear infinite;
    animation-delay: var(--phase-delay, 0ms);
  }

  .task-ring.face-orbit {
    --orbit-rx: 1.35rem;
    --orbit-ry: 0.49rem;
  }

  @keyframes task-ring-orbit {
    0%,
    100% {
      translate: -50% calc(-50% - var(--orbit-ry));
    }
    8.333% {
      translate: calc(-50% + var(--orbit-rx) * 0.5) calc(-50% - var(--orbit-ry) * 0.866);
    }
    16.667% {
      translate: calc(-50% + var(--orbit-rx) * 0.866) calc(-50% - var(--orbit-ry) * 0.5);
    }
    25% {
      translate: calc(-50% + var(--orbit-rx)) -50%;
    }
    33.333% {
      translate: calc(-50% + var(--orbit-rx) * 0.866) calc(-50% + var(--orbit-ry) * 0.5);
    }
    41.667% {
      translate: calc(-50% + var(--orbit-rx) * 0.5) calc(-50% + var(--orbit-ry) * 0.866);
    }
    50% {
      translate: -50% calc(-50% + var(--orbit-ry));
    }
    58.333% {
      translate: calc(-50% - var(--orbit-rx) * 0.5) calc(-50% + var(--orbit-ry) * 0.866);
    }
    66.667% {
      translate: calc(-50% - var(--orbit-rx) * 0.866) calc(-50% + var(--orbit-ry) * 0.5);
    }
    75% {
      translate: calc(-50% - var(--orbit-rx)) -50%;
    }
    83.333% {
      translate: calc(-50% - var(--orbit-rx) * 0.866) calc(-50% - var(--orbit-ry) * 0.5);
    }
    91.667% {
      translate: calc(-50% - var(--orbit-rx) * 0.5) calc(-50% - var(--orbit-ry) * 0.866);
    }
  }
</style>
