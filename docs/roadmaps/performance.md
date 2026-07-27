# Performance roadmap

## Current state

Clippity is event-driven and already contains deliberate optimizations: memoized
scene nodes, a 100-step undo cap, a 160-entry thumbnail LRU, lazy thumbnails,
idle animation pausing, an unloadable ONNX session and a reduced-effects mode.
A prior 250-node browser profile found normal single-node drags smooth. The
remaining risks are native capture/encode latency, six always-alive WebViews,
large images/libraries, backend thumbnail re-decode, frame-shell rendering and
broadcast recording events.

## Strengths to preserve

- Profile-informed changes rather than speculative micro-optimization.
- Fine-grained store selectors and operation-scoped threads.
- Explicit RAM-for-warm-show tradeoff and user-controllable effects.
- Release LTO/one-codegen-unit profile and isolated heavy Rust dependencies.

## Gaps and opportunities

- No automated cold/warm startup, hotkey-to-overlay, selection-to-save, library
  scroll/search, export or idle-resource budgets.
- The backend still decodes full images for thumbnail misses.
- High-frequency scrolling/recording events are broadcast to all windows.
- Editor source imagery stays decoded when the app hides; very large scene and
  multi-monitor/HiDPI behavior lacks a native stress harness.
- One frontend bundle boots per window; six WebViews prioritize latency over
  memory without adaptive lifecycle rules.

## Initiatives

| ID | Class | Recommendation | Priority | Impact | Complexity | Dependencies |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | Quick win | Emit recording tick/preview only to toast; coalesce transient gesture store writes if profiling confirms value. | P1 | Medium | S | Event-routing tests. |
| P2 | Foundation | Add a repeatable native benchmark harness and budgets for startup, overlay, still save, OCR, scroll stitch, search, editor gestures, idle CPU/RAM and installer size. | P0 | High | M | CI Windows runner, seeded corpora. |
| P3 | Foundation | Add disk-backed generated thumbnails keyed by content stamp, decode size and renderer version; invalidate through the reconciled index. | P1 | High | L | Library schema/migration, storage policy. |
| P4 | Major | Stream/tile very large editor images and release decoded bitmaps when hidden while retaining scene state and dirty recovery. | P1 | High | L | Scene lifecycle, autosave. |
| P5 | Major | Introduce library virtualization and SQL/FTS-backed query plans for 50k–250k items. | P1 | High | L | Search/index roadmap. |
| P6 | Major | Evaluate adaptive window lifecycle: keep capture/overlay warm, suspend or recreate rarely used utility WebViews. | P2 | Medium | XL | State hydration, native measurements. |
| P7 | Experiment | GPU-accelerated renderer/export path for huge scenes, effects and video overlays. | P3 | High | XL | Rendering abstraction, benchmark proof. |

## Milestones and phases

- **Short term:** instrument performance marks; capture a reproducible baseline;
  land targeted event routing; set CI budgets with warning and failure bands.
- **Mid term:** persistent thumbnail pipeline, virtualized library, large-image
  editor lifecycle and scroll/record memory backpressure.
- **Long term:** adaptive WebView lifecycle and, only if CPU profiles justify it,
  a GPU renderer/media pipeline.

Implementation phases: (1) measure representative hardware; (2) establish
budgets; (3) optimize the highest user-visible percentile; (4) stress/fault test;
(5) guard with regression dashboards.

## Success criteria

- Hotkey-to-interactive-overlay p95 <250 ms warm and <600 ms cold.
- Selection-to-saved-result p95 <1.5 s for a 4K PNG; UI feedback <100 ms.
- Smooth editor drag at ≥55 fps for 500 ordinary nodes on reference hardware.
- Library first useful paint <500 ms and search p95 <150 ms at 50k entries.
- Hidden/tray CPU statistically indistinguishable from zero; bounded RAM after
  1,000 captures and 100 open/edit/close cycles.
- No >10% regression to bundle size or benchmark percentiles without an
  approved tradeoff.

## Risks, tradeoffs and alternatives

- Destroying WebViews saves RAM but harms instant access; prefer measurement and
  tiered lifecycle to a blanket rewrite.
- Disk thumbnails improve speed but increase storage/privacy footprint; make the
  cache bounded, inspectable and clearable.
- GPU paths add driver/platform complexity; Canvas/SVG with tiling may remain
  simpler and fast enough.
- Performance marks must avoid recording capture content or sensitive titles;
  collect timings and sizes only.

