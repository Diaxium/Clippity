# Testing and quality roadmap

## Current state

The repository has excellent unit/component/domain depth: 1,235 frontend tests
in 102 files plus a large Rust suite, with clean TypeScript, ESLint, Cargo check
and Clippy. IPC clients are easy to stub and pure domain logic is well isolated.
The missing layers are native integration, cross-window workflows, packaging,
visual/accessibility regression, performance budgets, coverage governance and
fault/migration/security testing. There is no CI configuration.

## Strengths to preserve

- Tests colocated with behavior and fast pure-domain coverage.
- Characterization of complex editor geometry, selection and rendering.
- Contract wrapper tests and clean static analysis.
- Smoke entry points for library/editor/overlay development.

## Problems and missed opportunities

- A green jsdom suite does not prove WebView/Tauri commands, native capture,
  focus, tray, global shortcuts, clipboard, OCR/models or installers work.
- No end-to-end coverage of capture → save → library → edit → export.
- No coverage report/threshold or risk-based test ownership.
- Persistence corruption, disk full, permissions, model failure, update rollback
  and process interruption are not system-tested.
- Visual snapshots are manual and the current UX-review docs are incomplete.

## Initiatives

| ID | Class | Recommendation | Priority | Impact | Complexity | Dependencies |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Foundation | Windows CI matrix for frozen install, check, lint, unit tests, format, build and artifact upload with caching. | P0 | High | M | Hosted/self-hosted runner. |
| T2 | Foundation | Native E2E harness for window creation/routing, capture fixture, library mutation, editor save/export, tray/countdown/toast and restart persistence. | P0 | High | XL | Test-mode native providers. |
| T3 | Foundation | Contract conformance tests generated from Rust schema plus command/event inventory checks. | P0 | High | M | Architecture A1. |
| T4 | Foundation | Accessibility and visual-regression matrix across themes, accents, DPI, reduced motion and high contrast. | P0 | High | L | UI/component explorer. |
| T5 | Foundation | Fault/migration tests: malformed/old/future JSON, interrupted writes, disk full, permissions, missing files, corrupt DB/model and recovery. | P0 | High | L | Atomic persistence. |
| T6 | Major | Performance benchmarks and budgets in a stable nightly/reference-hardware lane. | P1 | High | L | Performance harness. |
| T7 | Major | Security/property/fuzz testing for path containment, data URIs, image decoders, IPC validation, recipe/deep-link inputs and parsers. | P1 | High | Security boundaries. |
| T8 | Major | Installer/update/uninstall smoke tests, code-signature verification and rollback channels. | P0 | High | Release pipeline. |
| T9 | Experiment | Differential renderer tests comparing SVG preview and flattened export at pixel/semantic tolerance. | P2 | Medium | Deterministic renderer. |

## Milestones and implementation phases

- **Short term:** T1, T3–T5 and one golden native journey; publish current
  coverage rather than chasing an arbitrary global percentage.
- **Mid term:** broaden T2, add T6–T8 and release-channel promotion gates.
- **Long term:** renderer differential/fuzz depth and macOS/Linux matrices.

Build test layers from deterministic fixture providers → one happy journey →
permission/failure variants → multi-monitor/HiDPI/native integrations →
packaged binary → update/rollback. Keep slow lanes separate but release-blocking.

## Success criteria

- Every change runs reproducible CI; default branch and release artifacts are
  always built from green commits.
- Core native journey pass rate ≥99% with <1% flaky reruns over 30 days.
- Every P0/P1 defect gets a regression test at the lowest useful layer.
- 100% durable schema migrations and security boundary cases covered.
- Release candidate passes install, first run, update, rollback and uninstall on
  supported Windows versions; no capture data is removed on uninstall by
  surprise.
- Performance/visual/a11y regressions fail before release, with reviewable
  artifacts.

## Risks, tradeoffs and alternatives

- Pixel snapshots are brittle; compare stable component states and use semantic
  tolerances for rendered content.
- Native E2E can be slow/flaky; add injectable capture/window/clock/model
  providers and reserve a smaller real-desktop suite for release/nightly.
- Coverage percentages can reward low-value tests; track critical-path and
  mutation/property coverage alongside line coverage.

