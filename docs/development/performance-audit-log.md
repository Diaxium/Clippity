# Performance Audit Log

## Date

2026-06-14

## Scope

Performance & efficiency audit of the Clippity codebase (Tauri 2 app:
React 19 + TypeScript + Zustand frontend, layered Rust backend). The audit
prioritized the **editor** — the per-frame, interaction-heavy subsystem that
dominates user-perceived responsiveness — and did lighter passes over state
management, memory lifecycle (timers/listeners/history/caches), the
image-heavy library path, and the dependency footprint.

Backend Rust services were statically reviewed but **not run/profiled**: the
app is Windows-native with bundled ONNX/OCR/Win32 dependencies and no
headless harness was available this session. Findings there are static-only
and marked accordingly.

## Summary

The frontend is generally well-architected: fine-grained Zustand selectors
(no whole-store subscriptions), module-level thumbnail caching with
in-flight dedup and `IntersectionObserver` lazy-loading, deferred pixel work
in `useEffect`, memoized raster gradients, and clean listener hygiene (the
only unpaired `addEventListener`s are intentional app-lifetime error
handlers in `main.tsx`).

The audit found **one high-impact runtime issue** (the scene-node tree was
not memoized, so a single drag re-ran every node's render work each pointer
tick) and **one memory issue** (the undo stack was unbounded). Both were
fixed with contained, behavior-preserving changes, plus one minor cleanup
(skip a per-pointer-move store write when its only consumer is hidden). All
691 frontend tests pass (one added), typecheck and lint are clean.

## Findings

### Finding 1 — Scene-node views re-render the whole tree on every drag tick

- Severity: **High**
- Confidence: **Confirmed** (code path traced end-to-end)
- Status: **Implemented Now**
- Category: Runtime performance / unnecessary re-render & recompute
- Files affected: `features/editor/components/SceneNodeView.tsx`,
  `features/editor/components/EditorCanvas.tsx`
- Issue: `SceneNodeView` was a plain (non-memoized) function component
  receiving the entire `nodes` map as a prop. Every transient drag/resize/draw
  update (`moveNodes`/`updateNode`/`resizeNode` with `{ transient: true }`)
  rebuilds the `nodes` map reference via `withNode` (`{ ...nodes, [id]: next }`).
  `EditorCanvas` subscribes to `s.nodes`, so it re-renders each pointer tick
  and re-runs `rootIds.map(id => <SceneNodeView node nodes />)`. Because the
  views were unmemoized and `nodes` changed identity every tick, **every** node
  in the scene re-ran its render work each tick — recomputing polygon/star
  outlines (trig), gradient geometry, point/path strings, and `findBaseImage`
  scans — at ~60–120 Hz, for nodes that did not move.
- Evidence: `EditorCanvas.tsx:936` mapped all roots with `nodes` threaded in;
  `editorStore.ts` `moveNodes`/`mutate` return a fresh `nodes` object per
  transient tick; `SceneNodeView` had no `memo`. The `nodes` prop is used in
  exactly two places (verified by grep): container child recursion
  (`FrameView`) and sample base-image lookup (`findBaseImage(nodes)`); for all
  other nodes the SVG output is a pure function of `node`.
- Performance impact: drag/resize/draw cost scaled **O(all nodes)** per tick
  instead of O(moved). On a busy annotated screenshot (many shapes, frames,
  gradients, effects) this is the most likely source of drag jank.
- Fix: wrap `SceneNodeView` in `React.memo` with a custom comparator
  (`nodeViewPropsEqual`): re-render only when the node's own object changes,
  except containers (a descendant may move while the frame object stays
  referentially equal) and sample nodes (depend on the shared base image),
  which still compare the `nodes` reference. Net effect: a drag re-renders the
  moved node(s) + a cheap shell re-render for frames/samples; the bulk of leaf
  nodes skip entirely.
- Risk of change: Low–medium, contained to one component boundary. Output is a
  pure function of `(node, nodes)`; the comparator is conservative for the two
  map-dependent cases.
- Validation: full editor suite (353 tests incl. 20 `sceneNodeView` tests) +
  full app suite (691) pass; typecheck + lint clean.

### Finding 2 — Unbounded undo history (memory growth over long sessions)

- Severity: **Medium**
- Confidence: **Confirmed**
- Status: **Implemented Now**
- Category: Memory / global cache with no eviction
- Files affected: `features/editor/state/editorStore.ts`
- Issue: every history push (`past: [...s.past, snapshot]`) appended a
  whole-document snapshot with **no cap**, at all four push sites (lazy-txn
  snapshot, non-txn mutate, `pushHistory`, `redo`). Unchanged nodes are shared
  by reference (structural sharing limits per-step cost), but `past` itself
  grows monotonically, pinning every superseded `nodes` map and node object for
  the life of the session.
- Evidence: `editorStore.ts` push sites were `[...s.past, …]` with no slice;
  no `HISTORY_LIMIT` existed.
- Performance impact: slow, unbounded heap growth during long editing sessions.
- Fix: added a `HISTORY_LIMIT = 100` and a `pushPast()` helper that drops the
  oldest entries beyond the cap; routed all four push sites through it. `future`
  is implicitly bounded (it only grows via undo, which is bounded by `past`).
- Risk of change: Low. Behavior change = undo depth limited to 100 steps
  (standard for editors; the prior unbounded behavior was itself the defect).
- Validation: added a regression test (`caps the undo stack…`) asserting the
  stack stays at 100 after 150 edits and recent undo still works; suite green.

### Finding 3 — Per-pointer-move store write with no live consumer

- Severity: **Low**
- Confidence: **Confirmed**
- Status: **Implemented Now**
- Category: Redundant work / avoidable store churn
- Files affected: `features/editor/components/EditorCanvas.tsx`
- Issue: `onPointerMove` called `store.setCursor(screenToScene(...))` on **every**
  pointer move (even while merely hovering), allocating a fresh `{x,y}` and
  triggering a store-wide notification (every selector re-evaluates). In the
  editor, `s.cursor` is consumed by exactly one component, `CanvasRulers`, which
  is only mounted when rulers are shown.
- Evidence: grep of editor `s.cursor` consumers → `CanvasRulers.tsx:136` only;
  `CanvasRulers` is gated behind `{showRulers && …}` in `EditorCanvas`.
- Performance impact: minor — avoidable selector churn on every mouse move when
  rulers are off (the common default).
- Fix: guard the write with `if (store.showRulers)`. When rulers are off the
  field has no consumer; the next move repopulates it on toggle-on.
- Risk of change: Low. No code reads `s.cursor` during gestures.
- Validation: existing cursor test (`setCursor` is exercised directly, not via
  the move handler) still passes; suite green.

## Changes Made

### Change 1 — Memoize `SceneNodeView`

- Files changed: `features/editor/components/SceneNodeView.tsx`
- Reason: Finding 1.
- Before: `export function SceneNodeView({ node, nodes }) { … }` (re-rendered
  for all nodes whenever `nodes` identity changed).
- After: `const SceneNodeView = memo(SceneNodeViewImpl, nodeViewPropsEqual)`,
  where the comparator skips re-render unless the node's own object changed
  (containers/samples additionally compare the `nodes` reference). Added
  `memo` + `isContainer` imports.
- Risk: Low–medium (single component boundary).
- Validation: 691 tests, typecheck, lint all green.

### Change 2 — Bound the undo stack

- Files changed: `features/editor/state/editorStore.ts`,
  `features/editor/state/editorStore.test.ts`
- Reason: Finding 2.
- Before: four `[...s.past, snapshot]` sites with no cap.
- After: `HISTORY_LIMIT = 100` + `pushPast()` helper used at all four sites;
  added a regression test.
- Risk: Low (undo depth capped at 100).
- Validation: new test asserts cap + recent-undo correctness; suite green.

### Change 3 — Skip cursor store write when rulers are hidden

- Files changed: `features/editor/components/EditorCanvas.tsx`
- Reason: Finding 3.
- Before: `store.setCursor(screenToScene(...))` ran every pointer move.
- After: wrapped in `if (store.showRulers)`.
- Risk: Low.
- Validation: suite green.

## Deferred Recommendations

### Recommendation 1 — Thumbnail cache has no LRU eviction

- Reason deferred: already acknowledged in `useThumbnail.ts`; only bites very
  large libraries (≈10k captures × tens-of-KB base64). Low severity.
- Suggested owner: Library feature.
- Suggested next step: add LRU/size-bounded eviction keyed by `(id,maxWidth)`.

### Recommendation 2 — Backend `thumbnail` re-decodes the full image per call

- Reason deferred: mitigated in practice by the frontend module-level cache +
  in-flight dedup; only a cost if the cache is bypassed. Static-only (backend
  not profiled).
- Suggested owner: Backend / library_service.
- Suggested next step: if profiling shows repeated decode, add a small
  decoded-image or thumbnail LRU in `library_service`.

### Recommendation 3 — Frame "shell" re-renders O(frames)/tick during unrelated drags

- Reason deferred: the memo comparator (Finding 1) conservatively re-renders
  containers on any `nodes` change so descendant moves are never missed; their
  memoized children still skip. Cost is O(frames), not O(all nodes) — a large
  win already. Further reduction needs a refactor.
- Suggested next step: split a frame's own shell (pure in `node`) from its
  children list (depends on `nodes`) so the shell can memoize independently.

### Recommendation 4 — Multiple store writes per drag tick

- Reason deferred: a move tick issues `moveNodes` + `setGuides` +
  `setTransformHud` (+ `setCursor` when rulers on), each notifying all
  subscribers. Selectors are cheap and the dominant render cost is addressed by
  Finding 1; batching is a micro-optimization.
- Suggested next step: coalesce transient gesture writes into one `set`.

## Validation Results

- Commands run:
  - `npx tsc -b --noEmit` → exit 0 (clean)
  - `npx vitest run src/features/editor` → **353 passed**
  - `npx vitest run` (full app) → **691 passed** (74 files)
  - `npx eslint` on the 4 changed files → exit 0 (clean)
- Tests passed: 691 / 691 (one added: undo-stack cap regression)
- Tests failed: 0
- App run status: not launched (Tauri/Windows-native build not exercised this
  session; changes are pure frontend logic covered by the unit/component suite)
- Visual inspection status: not performed (no running app); behavior preserved
  by construction and verified by the component suite

## Reviewer Notes

- All three fixes are frontend-only and confined to the editor feature; no
  backend, dependency, or public-API changes.
- The memo comparator (`nodeViewPropsEqual`) is the one piece to keep correct
  if the renderer evolves: any new external dependency of a node's SVG output
  (beyond `node`, container children, or the sample base image) must be folded
  into the comparator, or the memo could skip a needed re-render.
- Backend services (overlay/scroll/vision/capture) were not profiled; deeper
  runtime profiling there is a reasonable follow-up if backend latency is ever
  reported.

---

# Idle-Resource Audit (background / unfocused / tray)

## Date

2026-06-14 (second pass)

## Scope

Targeted follow-up focused on a single question: **how much RAM / CPU / GPU
does the app burn while idle** — unfocused, minimized, hidden, or sent to the
tray. Covered the whole codebase but weighted toward app lifecycle: the
multi-window model, background threads, timers/RAF, looping animations, IPC
event fan-out, and session-lifetime caches. Static review for backend (no
headless Windows harness this session); frontend changes are covered by the
unit/component suite.

## Summary

The app is **already quiet at idle on the CPU side**. There are **no
`setInterval`s anywhere in the frontend** and **no persistent polling threads
in the backend** — every backend thread (`scroll_capture` worker, `model`
download, overlay loupe-encode) is operation-scoped and exits on a stop flag,
and every frontend timer/RAF is tied to an active, visible state (countdown
strip, toast auto-dismiss, copy-confirmation). State is event-driven, not
polled.

The real idle costs are structural to the **six-webviews-kept-alive** design
(ADR 0003 — windows are hidden, never destroyed, for fast re-show):

1. **GPU/compositor:** looping CSS animations keep compositing even when the
   window is unfocused or hidden — chiefly the capture button's infinite
   "breathing" ring in the default (capture) window.
2. **RAM:** the module-level thumbnail cache grew unbounded for the session;
   the ONNX detector session stayed resident after a single object-mode use.

Three contained, behavior-preserving fixes landed, all verified. **696
frontend tests pass (5 added), Rust `cargo check` + `vision_service` tests
pass, typecheck + lint clean.**

## Findings

### Finding 4 — Looping animations keep the compositor/GPU busy on idle windows

- Severity: **Medium-High** (idle GPU/CPU)
- Confidence: **Confirmed** (every window shares one bundle via `Providers`;
  the capture window is the default boot window and is the one users leave
  open and walk away from)
- Status: **Implemented Now**
- Category: Idle GPU / unnecessary rendering
- Files affected: `shared/hooks/useWindowActivity.ts` (new),
  `app/Providers.tsx`, `styles/theme.css`
- Issue: infinite CSS keyframe animations (`.capture-ring` breathing glow on
  the capture button — `clippity-breathe … infinite`; `.crosshair-dot` pulse;
  the Tailwind `animate-spin/pulse/ping/bounce` utilities) advance their
  timelines and force per-frame compositing **even while their window is
  unfocused, minimized, or hidden in the tray**. Every window is kept alive for
  the whole session, so an off-screen window's looping animation is pure waste.
  The breathing capture ring is the standout: the capture window is the default
  window users leave visible-but-unfocused.
- Fix: added `useWindowActivity` — a per-window hook (mounted once in
  `Providers`, so every window gets it) that combines Tauri `onFocusChanged`
  (authoritative OS focus), `document.visibilitychange` (minimize/occlusion),
  and DOM `blur`/`focus` into a single signal written to `<html data-idle>`. A
  window is idle when it is NOT (focused AND visible); never-focused utility
  windows (toast/countdown, created `focused:false`) are gated on visibility
  alone via an `everFocused` latch so they still animate while shown. `theme.css`
  pauses the looping animations under `[data-idle="true"]` with
  `animation-play-state: paused`. One-shot entrance animations (sub-second) and
  JS/Web-Animations motion (Framer Motion, which self-pauses when hidden) are
  intentionally untouched. Animations resume seamlessly on focus.
- Risk of change: Low. CSS-only pause of declarative loops; no JS animation
  affected; the signal is additive (`data-idle` defaults to active).
- Validation: 4 new hook tests (active start, blur→idle→focus, hidden→idle,
  never-focused-stays-active) + full suite green; typecheck + lint clean.

### Finding 5 — Unbounded session-lifetime thumbnail cache (resolves Rec. 1)

- Severity: **Medium** (idle RAM)
- Confidence: **Confirmed**
- Status: **Implemented Now** (was Deferred Recommendation 1 above)
- Category: Memory / cache with no eviction
- Files affected: `features/library/hooks/useThumbnail.ts`,
  `features/library/hooks/useThumbnail.test.ts`
- Issue: the module-level `Map<`(id,width)`, dataURI>` held every decoded
  thumbnail for the whole session — base64 strings of tens-to-hundreds of KB —
  never released, even after the dashboard window is hidden to the tray.
  Scrolling a large library climbs idle RAM without bound.
- Fix: turned the Map into a bounded LRU (`CACHE_LIMIT = 160`) via `cacheGet`
  (re-inserts on hit = mark most-recent) / `cacheSet` (evicts oldest over the
  cap). A re-scroll past an evicted capture just re-decodes through Tauri.
- Risk of change: Low. Pure cache-bound; in-flight dedup and lazy
  `IntersectionObserver` loading unchanged.
- Validation: added an LRU eviction test (stream 200 distinct captures → size
  stays ≤160, most-recent served from cache, oldest re-decodes); suite green.

### Finding 6 — ONNX detector session stays resident after object-mode use

- Severity: **Medium** (idle RAM, object-mode users only)
- Confidence: **Confirmed** (static)
- Status: **Implemented Now**
- Category: Memory / retained model weights when backgrounded
- Files affected: `services/vision_service.rs`, `lib.rs`
- Issue: `VisionService` caches one live ONNX `Session` (tens of MB of model
  weights) after the first object-mode capture, held until the model changes or
  is removed. It survives the app being sent to the tray, so a backgrounded app
  keeps a detector the user isn't using resident in RAM.
- Fix: added `VisionService::release()` (drops the cached session) and call it
  from the `CloseRequested` hide-to-tray handler in `lib.rs` **only when no
  primary window remains visible** (`window_service::current_visible_primary`
  is `None` = app effectively in the tray). Self-healing: `detect` lazily
  rebuilds the session on the next object-mode capture. No-op when object mode
  was never used.
- Risk of change: Low. Best-effort, behind a "nothing visible" guard; the
  rebuild path already existed and is exercised by the model-change branch.
- Validation: `cargo check --lib` clean; new `release_is_a_safe_noop_…` test +
  existing 5 `vision_service` tests pass.

## Idle Resource Strategy (intended behavior)

| App state | Behavior |
| --- | --- |
| Active / focused | Full behavior; all animations run. |
| Unfocused but visible | `data-idle="true"` → looping animations pause (no compositor churn). Focus-bearing windows (capture/main) only. Everything else unchanged. |
| Minimized / occluded | `document.hidden` → `data-idle="true"`; CSS loops paused; Framer Motion + RAF self-pause; WebView2 occlusion throttles the rest. |
| Tray / hidden (no primary visible) | All of the above **plus** the ONNX detector session is freed. Webviews stay resident (ADR 0003) for instant re-show. |
| Restored from tray | `onFocusChanged(true)` / `visibilitychange` → `data-idle="false"`; animations resume; ONNX session rebuilds lazily on next object-mode use. No duplicate timers/listeners (all are `useEffect`-scoped with cleanup). |

## Items reviewed and deliberately left as-is

- **Six always-alive webviews (ADR 0003).** The dominant idle-RAM line item,
  but an explicit RAM-for-latency trade. Out of scope for a "don't change
  behavior" pass; destroying/recreating windows is a separate architectural
  decision.
- **No frontend `setInterval`; backend has no polling threads.** Verified, not
  changed — already optimal.
- **`backdrop-filter` blur + Win11 Mica.** Real continuous-compositing cost,
  but already user-controllable via `performance.windowEffects` → `flat` mode
  (drops every blur + clears Mica). Left to the existing setting.

## Deferred Recommendations (idle pass)

### Recommendation 5 — High-frequency recording events broadcast to all windows

- `app.emit` (in `app/events.rs`) broadcasts to all six webviews. Most events
  are user-action-rate and harmless, but `recording/tick` + `recording/preview`
  fire continuously during a scroll/panoramic capture and only the toast window
  consumes them — every other (hidden) webview still wakes its JS to drop them.
  This is an *active-capture* cost, not an idle one, so it's low priority.
- Suggested next step: `emit_to("toast", …)` for the `recording/*` events
  (keep `library/updated`, `settings/changed`, etc. as broadcasts — those
  legitimately fan out).

### Recommendation 6 — Editor retains the source image when the main window hides

- The editor store keeps the loaded image + scene in memory when the main
  window is hidden to the tray (needed for instant re-show). For very large
  captures this is non-trivial retained RAM while backgrounded.
- Reason deferred: clearing it trades idle RAM for a reload on re-show and
  needs a careful dirty-state/restore path. A real lifecycle feature, not a
  cleanup.
- Suggested next step: on "no primary visible", drop decoded image bitmaps that
  can be re-derived from disk, keeping only the (small) scene JSON.

## Validation Results (idle pass)

- Commands run:
  - `cargo check --lib` (backend) → finished clean
  - `cargo test --lib vision_service` → **5 passed** (1 added)
  - `tsc -b --noEmit` (frontend) → exit 0 (clean)
  - `vitest run` (full app) → **696 passed** (75 files; 5 added)
  - `eslint` on the 5 changed/added frontend files → exit 0 (clean)
- App run status: not launched (Tauri/Windows-native build not exercised this
  session). The idle behavior is event/visibility-driven and unit-tested;
  real-world CPU/GPU/RAM measurement across focus/minimize/tray cycles is the
  recommended manual follow-up (see note below).
- Measurement note: precise before/after CPU/GPU/RAM numbers require running
  the bundled app under Task Manager / GPU profiler across the state matrix,
  which isn't possible headlessly here. The changes are structured so the win
  is deterministic (a paused animation does zero compositing; a freed session
  is freed RAM; a bounded cache cannot exceed its cap) rather than
  measurement-dependent.

---

# Overlay open-path latency (hotkey → interactive overlay + loupe)

## Date

2026-07-24

## Scope

The user-perceived gap between triggering a capture and (a) the overlay
appearing, (b) the magnifier loupe becoming usable. Measured on the
reference machine (1920×1200 single display, Parsec virtual adapter) with
a release build via an opt-in probe (`overlay_service` →
`overlay_show_path_timings`, `--ignored`) and the Criterion
`overlay_handoff` group.

## Baseline (before)

| Step | Cost | On path to… |
| --- | --- | --- |
| Fixed compositor sleep (`COMPOSITOR_UNPAINT_OVERLAY_MS`) | **260 ms** | overlay visible |
| `DwmFlush` ×2 | ~33 ms | overlay visible |
| `build_virtual_canvas` (screen grab) | ~30 ms | overlay visible |
| `canvas.clone()` (session + encoder thread) | ~1.4 ms | overlay visible |
| PNG encode + base64 → **11 MiB data URI** | ~31 ms encode + IPC + `atob` + 3× CSS decode | loupe usable |

~80% of the pre-overlay time was one fixed sleep, and the loupe payload
crossed the JSON IPC bridge as an 11 MiB base64 string decoded three
times (backdrop, magnifier, small preview).

## Changes

1. **Capture shield (the structural fix).** Every Clippity window is set
   `WDA_EXCLUDEFROMCAPTURE` at startup
   (`platform::windows::capture_shield::shield_windows`), so it renders on
   screen but is excluded from the capture pipeline. The desktop snapshot
   therefore cannot contain our chrome *no matter what is on screen when
   the grab fires* — so the overlay open path drops the hide-then-wait
   compositor settle entirely (`OverlayService::capture_shielded` gates
   it). Empirically validated on this machine's GDI capture path + Parsec
   display by an ignored probe (`capture_shield` tests): a magenta probe
   window goes from 250,000 captured pixels to **0** under the flag.
   Also fixes a latent bug — a lingering toast / countdown / tray flyout
   from a prior capture could previously contaminate the next snapshot;
   now they're excluded too.

2. **Snapshot transport.** The loupe image moved from a base64 data URI
   returned by a command to bytes served over a `clippity-snapshot://`
   URI scheme keyed by a per-session id. Kills the 11 MiB JSON payload,
   the main-thread `atob`, and the triple decode (the webview fetches and
   caches one decode for all three `url(…)` consumers). Backend keeps the
   PNG behind an `Arc` and the frontend `fetch`es the URL.

3. **Shared snapshot buffer.** The session and the loupe-encoder thread
   share one `Arc<RgbaImage>` instead of a full-desktop `clone()`
   (8 MiB → 33 MiB depending on resolution).

4. **Fallback path made deterministic.** For pre-2004 Windows / non-
   Windows (no shield), the old fixed 260 ms sleep was replaced by
   `window_service::settle_after_hide`, which polls `IsWindowVisible`
   until the hidden window is actually down (bounded), *then* flushes —
   so the flush can't present a frame that still contains the window.
   This was an interim fix before the shield; it now only guards the
   unshielded fallback.

## Result

On the shielded path (Windows 2004+), the entire compositor wait is gone
— the snapshot grab starts immediately after the hide is posted. The
loupe payload no longer crosses IPC as a string and is decoded once. The
capture window can no longer ghost into the snapshot, by construction.

## Validation

- `cargo test --workspace` → all pass (platform +1, services incl. the
  `spin_until` bound + snapshot-scheme response tests; `src-tauri`
  `snapshot_scheme_tests` +5).
- `capture_shield` probe (`--ignored`) → exclusion **WORKS** on this
  display (250000 → 0 → 250000 magenta px).
- Frontend `useOverlaySnapshot.test.tsx` (+5) asserts the pixels load
  over the URL, never through the IPC result, and share one decode.
- App launched (`pnpm tauri:dev`): boots clean, logs
  `applied capture shield to app windows shielded=true`, stable, no
  panics. End-to-end visual confirmation of a live region capture is the
  recommended manual check (can't drive a fullscreen overlay headlessly).

## Follow-ups (not done)

- `recapture_last` and the `finish_*` live-regrab fallbacks still do a
  fixed `sleep_compositor_unpaint(Capture)` + flush. With the shield those
  are dead latency too; they're rare (error/one-shot) paths, so left for a
  focused follow-up.
