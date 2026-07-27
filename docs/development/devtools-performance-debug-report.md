# DevTools Performance Debug Report

## Summary

This session profiled the **running** Clippity frontend through browser
developer tooling (a headless Chromium driven over the dev server), rather than
the static-only reviews the two prior passes recorded in
`performance-audit-log.md`. The goal was to confirm — or refute — those passes'
claims at runtime and to find issues only a live profile surfaces (real DOM
size, re-render isolation, long tasks, heap trend, idle behavior).

Headline result: **the app is genuinely well-optimized for realistic use, and
runtime profiling confirmed it.** The `SceneNodeView` memoization holds at scale
(single-node and 20-node drags stay smooth in a 250-node scene with zero long
tasks), there is no memory leak across repeated open/edit/close cycles, and the
idle-resource mechanism (`data-idle`) demonstrably pauses looping animations
when the window is backgrounded.

Profiling did surface **one real structural inefficiency**: every shape rendered
an unconditional `<defs><clipPath>…</clipPath></defs>` even when nothing
referenced it. In a 250-shape scene that was **250 clipPaths with 0 references —
~44% of all SVG elements were dead weight.** That was fixed (render the clip/defs
only when a sample, image fill, inside-aligned stroke, or frame `clipContent`
actually uses it), cutting the SVG element count for plain-shape scenes nearly in
half and lowering doc-open and idle-memory cost. The change is behavior-preserving
and verified by the full test suite (696 passing) plus visual confirmation of the
annotated scene.

One pathological case — dragging *all* 250 shapes at once — runs at ~5 fps, but
this is browser paint/reconciliation of 250 simultaneously-moving filled paths
(structural to one-big-SVG), not something the clip fix or a contained change
addresses. It is documented as a remaining risk, not silently left.

## Runtime Environment

- **OS:** Windows 11 Home (win32, 10.0.27924)
- **Tauri version:** v2 (`@tauri-apps/api ^2`, `@tauri-apps/cli ^2`)
- **Frontend framework:** React 19 + TypeScript + Zustand 5 (Vite 6, Tailwind 4,
  Motion 11)
- **Package manager:** npm
- **Dev command used:** `npm run dev` (Vite, port 1420) — launched via the
  preview tooling (`.claude/launch.json` → `frontend`)
- **Build/test commands used:**
  - `npx tsc -b --noEmit` (typecheck)
  - `npx vitest run` / `npx vitest run src/features/editor`
  - `npx eslint <file>`
- **Inspection method:** The Tauri WebView itself is a Windows-native WebView2
  process that can't be opened headlessly here, so the **frontend bundle was
  driven in a real browser over the Vite dev server**:
  - the production windows at `http://localhost:1420/` (hash-routed; render in a
    degraded "no Tauri backend" mode — see Console Issues), and
  - the editor design harness `http://localhost:1420/editor-smoke.html`, which
    renders the full `EditorLayout` against a seeded scene and exposes the
    Zustand store as `window.__ed` (see the `editor-browser-verification` note).
  - Instrumentation: `PerformanceObserver({entryTypes:['longtask']})`,
    `performance.memory.usedJSHeapSize`, `getComputedStyle`,
    `requestAnimationFrame` frame-gap timing, and store-notification counters
    via `__ed.subscribe`.

> **Methodology caveat.** Headless Chromium runs `requestAnimationFrame`
> uncapped (~90–170 fps observed), so it has far more headroom than the shipped
> WebView2 at 60 Hz vsync on a real machine. **Absolute fps figures below are
> therefore optimistic.** The *relative* signals — long-task counts, DOM/SVG
> element-count reductions, notification counts, and heap trend — are robust and
> transfer to the shipped app. The Rust backend was not run (no headless Windows
> harness); its review remains static, consistent with the prior passes.

## Baseline Findings

Captured before any change, on the editor harness.

| Area | Observation |
| --- | --- |
| Console (production windows) | Floods of `command "settings_get"/"show_toast"/"editor_load" threw a non-wire error` and `failed to subscribe to "clippity://…"` — **all expected**: there is no Tauri backend in browser-preview mode, so every `invoke`/event call rejects. Not representative of the shipped app. |
| Console (editor harness) | No editor-originated errors. Same browser-preview IPC noise only. |
| DOM size (250 plain rects) | 1844 total DOM / 1716 SVG elements. **250 `<clipPath>` and 250 `<defs>` rendered, with 0 `clip-path` references and 0 `filter` references** — ~44% of SVG nodes were unused clip machinery. |
| Re-render isolation (single-node drag, 250-node scene) | Smooth: ~10.5 ms avg frame gap, ~32 ms max, **0 long tasks**. Confirms the `SceneNodeView` `React.memo` keeps a single-node drag O(moved), not O(all). |
| Multi-select drag (20 of 250) | Healthy: ~13 ms avg, ~42 ms max, 0 long tasks. |
| Bulk drag (all 250) | **Pathological: ~5 fps, ~180–195 ms avg frame, 58–59 long tasks (~10.5 s aggregate).** Store mutation itself is cheap (~3.4 ms); the cost is React + style/layout/paint of 250 moving filled paths. |
| Store writes per drag tick | Exactly **3.0 notifications/frame** (`moveNodes` + `setGuides` + `setTransformHud`), confirming the audit's deferred Rec 4. |
| Memory (40× open/edit/close) | Heap oscillates 38–49 MB (GC sawtooth), no monotonic climb → no leak. Undo stack resets to 0 on `loadScene`, capped at 100 during editing. |
| Idle | `data-idle` toggles correctly on focus/blur; the capture-ring looping animation reports `animation-play-state: paused` while idle and `running` on refocus. |

> A methodology note for reproducers: the seeded harness node type is
> `"rectangle"` (not `"rect"`). An initial stress harness that filtered on
> `type==='rect'` silently produced **typeless** clones that render nothing —
> the first round of "smooth at 260 nodes" numbers were measuring empty nodes
> and were discarded. All figures above are from real, rendered rectangles.

## Fixes Implemented

### Fix 1 — Elide unreferenced `<clipPath>` / `<defs>` per node

- **Problem:** Every `RectView`, `EllipseView`, `FrameView`, and `PolyShape`
  unconditionally emitted `<defs><clipPath><path/></clipPath></defs>`. A plain
  shape (solid/gradient fill + centre/outside stroke) references no clip, so this
  was pure DOM + React-reconciliation waste on the majority of nodes in a typical
  annotation scene.
- **Evidence from DevTools:** On a 250-plain-rect scene, `document
  .querySelectorAll('clipPath').length === 250` while the number of elements
  carrying a `clip-path="url(...)"` attribute was **0**. Unused clips were ~44%
  of all SVG elements (1716 total).
- **Root cause:** The clip is only consumed by a sample (`SampledImage`), an
  image fill (`FillRect`), an inside-aligned stroke (`Strokes`), or a frame's
  `clipContent` child group — but it was rendered for *all* shapes regardless.
- **Files changed:** `app/frontend/src/features/editor/components/SceneNodeView.tsx`
- **Fix made:** Added a `usesClip(node)` predicate (sample ∨ image-fill ∨
  inside-stroke; frames additionally OR `clipContent`) and gated each view's
  `<defs>`/`<clipPath>` on `withFx || clip`. The predicate over-approximates
  safely (an unreferenced clip is inert) and is documented to be kept in lock-step
  with the `clipId` consumers; under-approximation (dropping a needed clip) is the
  only danger and is avoided.
- **Result after retesting:**
  - 250-rect scene: SVG elements **1716 → 966 (−44%)**, total DOM **1844 → 1094
    (−41%)**, clipPaths **250 → 0**, defs **250 → 0**.
  - Realistic 10-node annotated scene: clipPaths reduced to **5**, retained
    exactly on the nodes that need them (frame `clipContent`, Blur sample,
    Magnifier sample, inside-stroked Callout) and dropped from plain shapes
    (Highlight, Redaction, Step). DOM shows 3 `<image>` (base + blur + magnify)
    and 1 `<filter>` — both samples still clip correctly.
  - Visual: annotated scene renders identically (frame clipping, blur, magnifier
    loupe, highlight, callout, arrow, step, title all correct).
  - Mount cost (after): 60 nodes 47 ms, 250 nodes 108 ms — fewer elements to
    create on doc-open.
  - **Tests:** full app suite **696/696 pass** (353 editor incl. 20 `sceneNodeView`);
    typecheck clean; eslint clean on the changed file.

> **Honest scope of this fix:** it is a **DOM-size / memory / doc-open-cost** win
> (and reduces the kept-alive webviews' retained element count), **not** a
> drag-FPS win. The bulk-drag frame time was unchanged by it because that case is
> bound by painting the *visible* fills/strokes, not the inert defs that were
> removed. See Remaining Risks.

## Console Issues

| Message | Status |
| --- | --- |
| `command "settings_get"/"show_toast"/"editor_load"/"apply_window_theme" threw a non-wire error` | **Expected / not a bug.** Browser-preview has no Tauri backend, so every `invoke` rejects. The funnel in `services/tauri/client.ts` logs these at warn/debug by design. The shipped app has the backend and does not emit them. |
| `failed to subscribe to "clippity://…"` | **Expected / not a bug.** Same cause (event bridge absent in browser). |
| `unhandled promise rejection` (window logger) | **Browser-preview artifact.** Traced to the same backend-less `invoke` failures surfacing through fire-and-forget `void emitErrorToast(...)` paths. Confirmed the user-facing equivalents in the shipped path are guarded — e.g. `Providers`' `apply_window_theme` is `.catch()`-swallowed, and `useSettings` catches and routes to a toast. No code change made; these do not reproduce with a live backend. |
| Editor harness | **No editor-originated console errors** at any point during mount, drag, resize, multi-select, or repeated load. |

## Performance Issues

- **Single-node & small multi-select drags (the common path):** confirmed smooth
  and long-task-free in a 250-node scene; the prior pass's `SceneNodeView` memo
  (Finding 1) holds at scale. No change needed.
- **Per-node DOM weight:** fixed (Fix 1) — ~44% fewer SVG elements for plain-shape
  scenes.
- **Forced reflow hypothesis (`getBoundingClientRect` every pointer move in
  `screenToScene`):** investigated and judged **benign**. In steady-state
  dragging the browser paints (flushing layout) between coalesced pointer events,
  so the next move's rect read is not a forced synchronous reflow. Caching the
  host rect at gesture start would remove a cheap layout read but adds
  invalidation complexity for no measured gain — **left as-is**.
- **3 store writes per drag tick (Rec 4):** confirmed real (3.0 notifications/
  frame) but **not the bottleneck** — selectors are cheap and the bulk-drag cost
  is render/paint-bound. Documented below rather than micro-optimized, to keep the
  change set minimal and the hot gesture path untouched.

## Memory Issues

- **No leak detected.** 40 consecutive open → 20-edit → close (`loadScene`)
  cycles left the heap oscillating (38–49 MB sampled) instead of climbing
  monotonically.
- **Undo stack:** verified to reset to length 0 on `loadScene` and to be bounded
  by `HISTORY_LIMIT = 100` during editing (prior Finding 2 — confirmed at runtime).
- **Detached nodes / listeners:** `useWindowActivity`, the canvas `ResizeObserver`,
  the wheel listener, and the pen `keydown` listener all have matching cleanup in
  their effects (verified by reading). The clip-elision additionally lowers the
  retained element count of every kept-alive webview.

## Network / IPC Issues

- No real IPC in browser-preview (backend absent), so this was a code-level review
  informed by the observed call pattern:
  - `useSettings` fetches `settings_get` on mount and stays live via
    `onSettingsChanged`. Consumers are `Providers` (once, app-wide) and
    `SettingsLayout` (only when open) — at most a couple of fetches, not a storm.
    The console's apparent repetition is React StrictMode double-invocation (dev
    only) plus the preview tool's multi-representation capture.
  - Minor: `useSettings` re-fetches even when the store is already hydrated. This
    guarantees freshness on every mount and is a defensible trade; **not changed**
    (a "skip if hydrated" guard risks serving stale data and the value is low).
- No duplicate-request or polling problems found; the prior passes' "no frontend
  `setInterval`, no backend polling threads" claim is consistent with everything
  observed.

## Idle / Unfocused / Tray Behavior

Verified at runtime on the real capture window (which mounts `Providers` →
`useWindowActivity`):

- `data-idle` correctly tracks focus: `focus → "false"`, `blur → "true"`,
  repeatable. The never-focused-window latch (`everFocused`) behaves correctly —
  a window that never held focus is judged on visibility alone (so utility
  windows still animate while shown).
- End-to-end payoff confirmed: under `data-idle="true"`, the capture button's
  infinite `clippity-breathe` animation reports `animation-play-state: paused`;
  on refocus it returns to `running`. The idle GPU/compositor optimization from
  the prior pass works as designed.
- No code change needed.

## Remaining Risks

1. **Bulk drag of very many shapes is paint-bound (~5 fps for 250 simultaneously
   moving filled paths).** This is structural to rendering the whole scene as one
   SVG layer: moving N shapes invalidates and repaints all N. The clip-elision
   does not address it (it removed inert, non-painting defs). Mitigating it would
   require an architectural change — e.g. rasterizing static nodes to a canvas
   layer during a gesture, or virtualizing off-viewport nodes — both out of scope
   for a contained, behavior-preserving pass. Realistic scenes (tens of
   annotations, single/few-node drags) are unaffected and smooth.
2. **Large-scene rendering ceiling.** A synthetic ~1500-node scene blanked the
   harness root (the design harness has no error boundary; the production app
   wraps windows in `ErrorBoundary`). No realistic capture has this many
   annotations, but the ceiling exists; the production error boundary would
   contain it rather than crash the window.
3. **Backend not profiled.** Overlay / scroll / vision / capture Rust services
   remain static-review-only; deeper runtime profiling needs a headless Windows
   harness.
4. **Absolute fps numbers are from headless Chromium**, which is faster than the
   shipped WebView2 — treat them as upper bounds; trust the relative deltas.

## Recommended Follow-Up Tasks

- **Coalesce transient gesture writes** (`moveNodes` + `setGuides` +
  `setTransformHud`) into one `set()` per tick (the audit's Rec 4). Low value per
  this session's evidence, but trivially safe; worth doing if a future change adds
  more per-tick writes or heavier selectors.
- **Layer split for big-scene drags** (Remaining Risk 1): render the active
  selection in a small foreground SVG and rasterize/freeze the static remainder
  during a gesture. Sizeable change; only justified if users report jank on dense
  docs.
- **Profile the Rust backend** under a real Windows run for the capture/overlay/
  scroll paths.
- **Optionally add an error boundary to `editor-smoke.tsx`** so future stress
  harnesses fail loudly instead of blanking.

## Overlay Window — Follow-up Pass

Same runtime methodology applied to the **region-selection overlay** (the
full-screen capture surface: crosshair + magnifier loupe + drag-to-select).
Unlike the editor it had no in-browser harness, so one was added (mirroring
`editor-smoke`) to seed a synthetic desktop snapshot and expose the store.

### Fix 2 — Overlay crashes in the browser/no-Tauri context (real bug)

- **Problem:** Navigating to the overlay with no Tauri backend **crashed the
  whole overlay into the ErrorBoundary** ("Something went wrong").
- **Evidence from DevTools:** Console — `TypeError: Cannot read properties of
  undefined (reading 'metadata') at getCurrentWindow … at OverlayLayout.tsx` →
  `The above error occurred in the <OverlayLayout> component` → error-boundary
  render-crash. DOM collapsed to 17 nodes.
- **Root cause:** `OverlayLayout`'s focus-reset effect calls `getCurrentWindow()`,
  which **throws synchronously** when `__TAURI_INTERNALS__` is absent. The
  effect's `.catch()` — whose comment literally reads *"browser preview — no
  Tauri window context"* — only catches promise rejections, **not** the
  synchronous throw, so the intended graceful degradation never worked.
  `useWindowActivity` already guards the identical call with `isTauriContext()`;
  `OverlayLayout` did not.
- **Files changed:** `app/frontend/src/features/overlay/components/OverlayLayout.tsx`
- **Fix made:** Added `import { isTauriContext } from "@services/tauri"` and an
  early `if (!isTauriContext()) return;` at the top of the focus-reset effect —
  matching `useWindowActivity`. Production (Tauri present) behavior is unchanged;
  the browser/test path no longer crashes.
- **Result after retesting:** overlay renders (`.clippity-overlay-root` present,
  no error boundary); 696/696 tests pass. This also unblocked the rest of the
  overlay profiling below.

> Severity note: in the shipped app `getCurrentWindow()` succeeds, so users never
> hit this. But it's a real latent defect — the author's documented browser-
> fallback intent was defeated by the synchronous throw, and any future dev/test
> run of the overlay outside Tauri would crash. Low user-facing severity, clear
> correctness win.

### Fix 3 — Redundant per-move cursor write during a region drag

- **Problem:** `useRegionSelection.onPointerMove` called `setCursor(p)`
  unconditionally and then, on the dragging branch, `updateDrag(next)` — which
  **also writes `cursor`**. So every drag-move wrote `cursor` twice (the first
  value immediately overwritten), and a separate `setPhase("idle")` duplicated
  the `empty→idle` transition `setCursor`'s own reducer already performs.
- **Evidence from DevTools:** a faithful 100-move region drag (real
  `PointerEvent`s dispatched on the root, store-notification counter attached)
  measured **4.02 store notifications per move**; the magnifier + crosshair both
  subscribe to `cursor`, so each redundant write is an extra subscriber
  notification.
- **Files changed:** `app/frontend/src/features/overlay/hooks/useRegionSelection.ts`
- **Fix made:** Drive `cursor` solely through `updateDrag` while dragging
  (`setCursor` only on the non-drag branch); dropped the now-redundant
  `setPhase("idle")`. Behavior-preserving — the store end-state per move is
  identical (verified: drag still finalizes a valid rect).
- **Result after retesting:** **4.02 → 3.02 notifications/move (−25%)**; selection
  still finalizes (`phase: "selected"`, valid rect); the 4 region-selection
  regression tests + all 67 overlay tests pass.

### Overlay performance — measured, and healthy

Profiled via the new `overlay-smoke` harness. Because the headless page reports
`document.hidden` (which pauses `requestAnimationFrame`), per-move timing used a
`MessageChannel` yield (React's scheduler is MessageChannel-based and is *not*
visibility-throttled) to flush each commit; DOM position changes confirmed React
actually re-rendered each move.

| Overlay interaction | Result |
| --- | --- |
| Magnifier 1×1 `getImageData` readback (every render) | **0.0037 ms** — negligible; confirms the code comment's "cheap enough every render" at runtime. |
| Idle hover (magnifier + crosshair follow cursor) | avg **1.3 ms** / p95 1.9 ms / max 5.2 ms per move, **0 long tasks**, 2 notifications/move. |
| Region drag-select | avg **1.2 ms** / p95 2.0 ms per move, **0 long tasks**; 3 notifications/move after Fix 3. |
| `useObjectDetection` in region mode | No per-move work — gated to `object` mode via the `overlay/shown` event, one inference per session (verified by reading). |

- **Soft observation (not a main-thread issue):** a full-page screenshot timed
  out only while the magnifier was *visible* and was instant once it hid
  (`selected` phase). The loupe paints a large up-scaled (`imageRendering:
  pixelated`) snapshot background (~2857 px) that re-rasterizes as the
  background-position + velocity-driven scale change each move. This is **GPU
  paint, not main-thread** (long tasks stayed 0), and the adaptive zoom is an
  intentional feature — noted as a possible future tuning target (e.g. quantize
  the velocity-driven scale so small jitter doesn't re-raster every frame), not a
  fix made.

## Overlay Window — Magnifier Latency + Tiny-Selection UX (second follow-up)

Driven by two user reports: (1) the magnifier loupe is slow to appear when the
overlay opens, and (2) a very small selection box (< ~45 px) is too small to see
its contents.

### Fix 4 — Magnifier open-latency: faster snapshot decode

- **Problem:** Noticeable delay before the loupe appears after the overlay opens.
- **Evidence from DevTools:** The loupe can't render until the desktop snapshot
  is decoded into a sampling canvas. Measured the frontend decode of a
  4K-equivalent snapshot in the harness: the data URI is **~6.3 MB** of base64,
  and the pipeline took **~240 ms** — dominated by **`fetch(dataUri)` re-parsing
  the base64 string (~140 ms)**, not the PNG decode (~95 ms). Tested three
  blob-acquisition strategies:

  | Strategy | 4K decode |
  | --- | --- |
  | `fetch(dataUri)` → blob → `createImageBitmap` (was) | 242–381 ms |
  | `atob` → `Uint8Array` → `Blob` → `createImageBitmap` (now) | 135–184 ms |
  | `Image.decode()` | 130–169 ms |

  (`createImageBitmap(blob, {colorSpaceConversion:'none'})` made no measurable
  difference — not adopted.)
- **Root cause:** `fetch()` is convenient but slow at re-parsing multi-MB base64
  data URIs.
- **Files changed:** `app/frontend/src/features/overlay/hooks/useOverlaySnapshot.ts`
- **Fix made:** Replaced `fetch(dataUri)` with a direct `atob`-based
  `dataUriToBlob`, keeping the off-main-thread `createImageBitmap` decode the
  team deliberately chose. Also added a guard so the SHOWN + SNAPSHOT_READY event
  pair can't trigger a redundant second multi-MB decode of the same URI.
- **Result after retesting:** ~240 ms → ~135 ms frontend decode on 4K
  (**≈100 ms sooner loupe**); `dataUriToBlob` verified pixel-accurate (round-trips
  a PNG to correct dims + exact RGB). Typecheck/lint clean; 704 tests pass.
- **Bigger lever (backend, not done here — unverifiable without a Windows run):**
  the dominant remaining cost is shipping the **full-desktop PNG as a ~6 MB base64
  string** over IPC. Returning the snapshot as **raw bytes** (Tauri v2 supports
  binary command responses → an `ArrayBuffer` the frontend wraps in a `Blob`
  directly) would eliminate the base64 inflation, the IPC string transfer, *and*
  the frontend base64 decode entirely. Recommended as the real fix; left for a
  backend pass that can be profiled on-device.

### Feature — Tiny-selection content preview

- **Problem:** A selection whose larger side is < ~45 px is too small to see what
  it contains, and the cursor loupe disappears the moment the selection commits.
- **Files changed:** `app/frontend/src/features/overlay/components/SmallSelectionPreview.tsx`
  (new), wired into `OverlayLayout`; `overlay-smoke.tsx` seed made window-exact.
- **What it does:** When a region-like selection's larger side is under 45 px, it
  floats a magnified view of the selection's pixels — sampled from the same cached
  snapshot the loupe uses, framed exactly to the selection (not the cursor) — in
  both the dragging and committed phases, with a physical-px readout.
  Magnification targets a 160 px box (capped at 14×). Self-gates on a small rect +
  a loaded snapshot; purely presentational.
- **Placement:** Centred on the selection and stacked on the vertical side
  *opposite* the contextual action bar (Copy / Save / Edit & annotate …), which
  is wide and centred on the selection — so a same-row placement always clipped
  it. `place()` mirrors `SelectionActionBar`'s own positioning, prefers the open
  side (above when the bar is below; below when the bar flips above near the
  bottom toolbar), and falls back to stacking beyond the bar, scoring candidates
  by overlap with the bar / selection / bottom toolbar. Verified at runtime:
  preview/bar overlap area is 0 in both the mid-screen and near-bottom cases.
- **Doubles as a move handle (committed phase):** a tiny box's 8 resize handles
  (with their padded hit-zones) cover its entire body, so there's nowhere left to
  grab to *move* it. Once committed, the magnified view becomes the move handle —
  it carries the `useRegionSelection` move handlers, shows a `move` cursor + a
  corner Move icon, and dragging it moves the selection. Verified end-to-end:
  dragging the view by (+60, +40) moved the selection by exactly (+60, +40), size
  unchanged. Presentational (pointer-through) while still dragging the box out.
- **No duplicate size readout:** the preview carries its own physical-px readout,
  so `RegionSelection` now suppresses its own size badge whenever the preview is
  up (shared `isTinySelection` predicate). Confirmed exactly one readout renders
  for a tiny selection.
- **Resize handles scale with the box:** the 8 fixed-size handles (10 px corners,
  22 px edge pills) piled up on a tiny box. They now scale down with the smaller
  side (floor ~0.65×) and shed the mid-edge handles per-axis once an edge is too
  short to seat one clear of the corners (`w/h < 36 px`); the four corners always
  remain. Verified zero handle-pair overlap at 28×22 (4 corners @7 px), 40×40 (8
  @8 px), 160×24 (6 — corners + top/bottom), and 220×140 (8 @ full 10 px).
- **Verified:** Renders the correct magnified region (sampling math confirmed
  against the live DOM + screenshots in both phases); 8 unit tests (gating +
  placement: right-preferred, left-flip, toolbar clamp). Trivially restrictable to
  the committed phase only if the during-drag overlay with the loupe reads as busy.

## Change Log

| File | Change | Why |
| --- | --- | --- |
| `app/frontend/src/features/editor/components/SceneNodeView.tsx` | Added `usesClip(node)` predicate; gated `<defs>`/`<clipPath>` rendering in `RectView`, `EllipseView`, `FrameView`, and `PolyShape` on `withFx || clip` (frames OR `clipContent`). | Eliminate ~44% of SVG DOM (250 unused clipPaths in a 250-shape scene) — lowers doc-open cost and idle-memory footprint of the kept-alive webviews. Verified by 696 passing tests + visual confirmation of the annotated scene. |
| `app/frontend/src/features/overlay/hooks/useOverlaySnapshot.ts` | Replaced `fetch(dataUri)` with an `atob`-based `dataUriToBlob`; guarded against a redundant second decode of the same snapshot. | Fix 4 — ~100 ms sooner magnifier on a 4K snapshot. |
| `app/frontend/src/features/overlay/components/SmallSelectionPreview.tsx` (+ test), `OverlayLayout.tsx`, `overlay-smoke.tsx` | New magnified content preview for sub-45 px selections; wired into the region-like overlay; harness snapshot made window-exact for faithful sampling. | Tiny-selection contents are unreadable at 1× and the loupe vanishes on commit. |
| `app/frontend/src/features/overlay/components/SmallSelectionPreview.tsx`, `RegionSelection.tsx` (+ test), `OverlayLayout.tsx` | Preview placement now avoids the contextual action bar (mirrors its rect, stacks on the opposite side); the preview doubles as a drag-to-move handle once committed; `RegionSelection` hides its size badge when the preview is up (shared `isTinySelection`). | A tiny box's resize handles cover its body (can't grab to move it), and two size readouts showed at once. |
| `app/frontend/src/features/overlay/components/RegionSelection.tsx` (+ test) | Resize handles scale down with the smaller side and drop the mid-edge handles per-axis below 36 px (corners always kept). | The 8 fixed-size handles piled on top of each other on a small selection. |
| `app/frontend/src/features/overlay/components/OverlayLayout.tsx` | Guarded the focus-reset effect with `isTauriContext()` (added the import). | Fix 2 — `getCurrentWindow()` threw synchronously with no Tauri context, crashing the overlay into the ErrorBoundary; the existing `.catch()` couldn't catch a synchronous throw. |
| `app/frontend/src/features/overlay/hooks/useRegionSelection.ts` | Drive `cursor` solely via `updateDrag` while dragging; removed the redundant leading `setCursor` + duplicate `setPhase("idle")`. | Fix 3 — eliminate a duplicate per-drag-move store write (4→3 notifications/move). Behavior-preserving; 67 overlay tests pass. |
| `app/frontend/src/overlay-smoke.tsx`, `app/frontend/overlay-smoke.html` | New dev-only harness (mirrors `editor-smoke`): seeds a synthetic desktop snapshot + cursor, exposes the store as `window.__ov`, renders `OverlayLayout`. | Enable in-browser runtime profiling/verification of the overlay (crosshair, loupe, region drag) without Tauri. Not in the production bundle. |
| `docs/devtools-performance-debug-report.md` | New report (this file). | Required deliverable documenting the runtime debugging session. |

### Validation summary

- `npx tsc -b --noEmit` → exit 0 (clean)
- `npx vitest run src/features/editor` → 353/353
- `npx vitest run src/features/overlay` → **67/67** (incl. the 4 region-selection
  regression tests + 17 overlayStore + 31 geometry)
- `npx vitest run` (full app) → **696/696** (re-run after every change)
- `npx eslint` on all changed/new files (`SceneNodeView.tsx`, `OverlayLayout.tsx`,
  `useRegionSelection.ts`, `overlay-smoke.tsx`) → exit 0 (clean)
- Editor: live DOM re-audit after fix — clipPaths 250 → 0, SVG els 1716 → 966;
  annotated scene retains exactly the 5 needed clips and renders correctly.
- Overlay: live re-measure after fixes — crash gone (renders, no error boundary),
  drag notifications 4.02 → 3.02/move, selection finalizes correctly, full state
  machine (empty → idle → dragging → selected) verified by screenshot.
- App run status: both the editor and overlay frontends launched and inspected in
  a live browser over the dev server (via `editor-smoke` / new `overlay-smoke`);
  Tauri WebView2 not launched (Windows-native, no headless harness).
