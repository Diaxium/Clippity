# Current-state product audit

## Executive assessment

Clippity is a visually polished Windows-first capture suite with a stronger
technical core than its 0.1.0 version suggests. The capture/overlay pipeline,
library model, layered editor and test suite are meaningful strengths. The main
risk is **expectation debt**: navigation and documentation advertise recording,
integrations, security controls, advanced settings and roadmap documents that
are absent or placeholders. The second risk is **release debt**: local checks
are excellent, but CI, native end-to-end tests, update delivery, security
hardening and recovery flows are not yet release-grade.

## What was inspected

- 452 frontend source files: 215 TSX files and 102 test files.
- 89 Rust source files across `infra`, `domain`, `platform`, `vision`,
  `services` and `src-tauri`.
- All six Tauri windows and their routes: capture, main, overlay, toast, tray
  and countdown.
- Product, architecture, getting-started, development, keybind and ADR docs.
- A live Windows build: capture hub, overlay, editor entry, library, presets and
  settings.
- Full validation: `pnpm check`, `pnpm test`, `pnpm lint`, and production npm
  audit. All passed; frontend result was 1,235/1,235 tests in 102 files. Cargo
  audit is not installed.

## Surface inventory

| Area | Current state | Assessment |
| --- | --- | --- |
| Capture hub | Region, window, fullscreen and custom capture; delay, cursor, clipboard, enhance, editor preview; effects/share selectors. | Complete core with good information hierarchy. Record is a prominent placeholder; output controls understate what “share” currently means. |
| Overlay | Rectangle, freehand, pen/Bézier, magnetic lasso, brush, multi-area, object, color, palette, OCR, scrolling and panoramic flows; magnifier and keyboard help. | Distinctive and polished. Custom cannot be switched from the overlay's own bottom bar; dense controls need keyboard/a11y validation. |
| Library | Image/video/GIF/aux taxonomy, favorites, trash, smart collections, tags, manual collections, grid/list, inspector and batch selection. | Strong model and empty state. Search is metadata-oriented; no import, OCR/semantic search, duplicates, saved searches, backup or storage-health workflow. |
| Editor | Non-destructive scene, annotate/design modes, 20+ tools, layers, multi-select, effects, gradients, chrome/backdrop, crop, save/export/copy and extensive keybinds. | A standout strength. Entry is empty until a library item is opened; Save As, preview refresh, rich text, group semantics and very large-file lifecycle remain incomplete. |
| Presets | Create/edit/delete/run; standard capture types, cursor/clipboard/editor/save-dir; tray launch. | Useful foundation but narrower than the capture product. No custom modes, effects, naming, destinations, ordering, duplicate/export or conditional steps. |
| Settings | General, appearance, notifications, performance and model management. | Live-applied and well structured. Eight visible categories are placeholders, including About and Privacy & Security; startup text admits the toggle is not implemented. |
| Onboarding | Theme, accent and storage setup with persisted completion. | Pleasant but configuration-led. It does not teach the core hotkey/overlay workflow, run a practice capture, explain privacy or verify permissions. |
| Tray | Quick still captures, cursor/copy/timed options, repeat region, recents, presets and main destinations. | Excellent power-user surface. Needs discoverability, customization, failure/retry feedback and parity with recipes. |
| Toast/countdown | Typed result bodies, per-kind duration, scrolling/panoramic controls and delay strip. | Thoughtful utility windows. Toast should evolve into a reversible result surface without becoming noisy. |
| Sharing/export | PNG/editor exports, copy, open, reveal and copy-path handoffs. | Functional local handoff, not yet true sharing. No format matrix, batch export, destinations, history, link lifecycle or credential model. |
| Vision | Downloadable ONNX models, object detection and Windows OCR. | Strong local-first differentiator. Integrity is size-based, model UX is advanced-user oriented, and macOS/Linux alternatives are absent. |

## Strengths worth preserving

- Native/local-first execution with no mandatory account or cloud dependency.
- Clear Rust layer direction and feature-oriented React organization.
- Shared TypeScript wire contracts and thin command/client wrappers.
- Rich, discoverable overlay instructions and unusually capable editor.
- Structured provenance, labels, collections and reconciled SQLite cache.
- Fine-grained Zustand subscriptions, idle animation pausing, bounded undo and
  thumbnail caches, lazy model sessions and prior performance discipline.
- Cohesive light/dark themes, custom accent, reduced-motion support, high-
  contrast overlay treatment and consistent desktop chrome.
- Extensive unit/component/domain tests, clean static analysis and valuable
  ADRs.

## Complete, partial, missing and inconsistent

### Complete or production-shaped

- Still capture and region-family selection.
- Clipboard/cursor/delay/smart-enhance options.
- OCR, color/palette capture, scrolling and panoramic capture.
- Library CRUD, trash/restore, tagging, favorites and collections.
- Core editor scene manipulation and flattened/editable save.
- Tray workflows, typed toasts, settings persistence and model management.

### Partial

- Presets are a capture snapshot, not yet workflow automation.
- Search does not exploit OCR/provenance or saved-query capabilities.
- Sharing is local OS handoff only.
- Cross-platform structure exists, but most capture/OCR/window behavior is
  Windows-specific.
- Settings wire shapes reserve more areas than the UI implements.
- Updater configuration exists, but the updater runtime/release path does not.
- Video/GIF categories and recording toast vocabulary exist without recording.

### Missing

- Native end-to-end, accessibility, packaging, migration and update tests.
- CI/CD, changelog, contributing/security policies and release channels.
- App import/drop/open-with integration.
- Command palette, customizable hotkeys and accessible canvas alternatives.
- Atomic versioned persistence, backup/restore and visible recovery UI.
- Real recording, batch export, integrations, sync/collaboration and automation
  triggers.

### Outdated or broken

- `docs/roadmaps/` was referenced throughout the repo but empty before this
  roadmap set.
- `docs/ux-review/README.md` is linked but absent.
- Performance docs contain historic test totals that no longer match the
  current 1,235 frontend tests.
- Building docs name a `src-tauri/target` artifact path while this workspace's
  artifacts are under `app/backend/target`.
- ADRs 0001–0008 were lost; later code still refers to some of their decisions.

### Confusing or redundant

- “History” in the capture rail opens the Library, while the main app calls it
  Library; “Capture” is both a window and a primary action.
- Capture and main windows use different primary navigation vocabularies and
  duplicate theme/settings affordances.
- Disabled “Soon” categories look like available destinations and create dead
  ends.
- The overlay exposes Region/Window/Fullscreen/Custom, but Custom is disabled
  even though custom modes are launched from the capture hub.
- Editor “Image/video…” suggests media support that the scene model does not
  fully communicate.

## User-perspective friction

| User | Likely friction | Opportunity |
| --- | --- | --- |
| First-time | Sees many modes before learning one; onboarding configures appearance rather than proving value; unclear hotkey/tray behavior. | Guided practice capture, permission check, result actions and a small first-week checklist. |
| Returning | Must mentally switch between capture window, main window and tray; result path depends on preview setting. | One consistent result contract and clear “where did my capture go?” feedback. |
| Power user | Presets omit custom modes and output chains; shortcuts cannot be changed; no CLI/URI/command palette. | Recipes, customizable triggers, batch actions, CLI and tray customization. |
| Accessibility user | Visual canvas and overlay dominate; custom select is incomplete; small text/targets and muted contrast are common. | Keyboard coordinate editing, semantic object/layer controls, scalable UI and WCAG program. |
| Privacy-sensitive | Local-first behavior is implicit; capture retention, model network access and sensitive-window exclusions are not explained. | Privacy center, offline indicator, app exclusions, ephemeral shelf and retention policies. |

## Highest-leverage decisions

1. Position Clippity as a **private visual workflow studio**, not a broad but
   shallow capture toolbox.
2. Use one canonical capture-result object/event so every mode can drive the
   same edit, copy, organize, share, undo and automation behavior.
3. Move unfinished promises to Labs/backlog until a user can complete the
   workflow end to end.
4. Stabilize data, permissions, updates and native tests before integrations or
   sync widen the threat and failure surface.
5. Measure successful outcomes and repeated time saved, not feature count.

