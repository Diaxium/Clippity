# Architecture and data roadmap

## Current state

The backend has a sound dependency direction (`infra → domain →
platform/vision → services → src-tauri`), and the frontend is organized by
feature with typed client wrappers and shared wire contracts. Six always-alive
WebViews share one bundle. Captures are files; provenance, labels and scenes are
sidecars; collections/presets/settings are JSON documents; SQLite is a
reconciled library cache. This is pragmatic and locally inspectable, but
contract duplication, large modules, persistence safety and lifecycle
coordination are reaching their next scaling limit.

## Strengths to preserve

- Pure domain rules isolated from Tauri and I/O.
- Thin command handlers and one IPC client seam.
- Local files remain the source of truth; SQLite can be rebuilt.
- Services consume narrow traits for live settings rather than global state.
- ADR culture captures non-obvious editor/data decisions.

## Problems and missed opportunities

- TypeScript and Rust wire types/event/command names are synchronized manually;
  TypeScript checks cannot detect a Rust/TS shape mismatch by themselves.
- `commands.rs`, `overlay_service.rs`, `library_service.rs`, `editorStore.ts`
  and the editor canvas/renderer have become high-change monoliths.
- JSON writes are generally whole-file, non-atomic and not consistently
  versioned/migrated; recovery is mostly log-only.
- Sidecars complicate rename/move/backup and eventually multi-root/sync
  semantics.
- High-frequency jobs use bespoke threads/events instead of a shared job model.
- One app-wide window capability and event broadcast model does not enforce
  least privilege or lifecycle ownership.

## Initiatives

| ID | Class | Recommendation | Priority | Impact | Complexity | Dependencies |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | Foundation | Generate TypeScript contracts/command clients from a versioned Rust schema, or validate both sides against emitted JSON Schema in CI. | P0 | High | L | Build tooling, migration policy. |
| A2 | Foundation | Introduce atomic write (`temp + flush + replace`), schema version, migrations, backup and recovery for every durable document/sidecar. | P0 | High | L | Fault-injection tests. |
| A3 | Foundation | Add a typed job service: id, phase, progress, cancel, retry, resumability, target window and durable result/error. | P1 | High | L | Error/event taxonomy. |
| A4 | Foundation | Split commands by domain and extract overlay/library/editor subservices and store slices at ownership seams, not arbitrary file sizes. | P1 | Medium | L | Characterization tests. |
| A5 | Major | Define canonical `CaptureArtifact`/`CaptureResult` and pipeline stages so stills, aux data, recordings and recipes share provenance/output behavior. | P0 | Transformative | L | Features/UX contract. |
| A6 | Major | Evolve the library index into a migration-managed catalog with FTS, content hashes, derived assets and multi-root readiness while files remain portable. | P1 | High | XL | Search/library roadmap. |
| A7 | Major | Platform capability interfaces for capture, OCR, audio, window enumeration and effects, with an explicit feature matrix. | P2 | High | XL | macOS/Linux targets. |
| A8 | Experiment | Sandboxed extension/output-action host with declarative permissions and out-of-process failure isolation. | P3 | Transformative | XL | Security/job/API maturity. |

## Milestones and implementation phases

- **Short term:** A1–A2, command-name/schema drift tests, persistence recovery UI
  and one canonical result contract design.
- **Mid term:** A3–A6 while recording/search/recipes are built on the new seams.
- **Long term:** platform interfaces and sandboxed extension host.

Sequence migrations as characterize current behavior → introduce parallel new
representation → dual-read/single-write with backup → validate/reconcile →
remove old path. Every migration must be idempotent and tested against corrupt,
partial and future-version data.

## Success criteria

- CI fails on any command, event or wire-shape drift.
- Power loss/fault injection at every persistence step loses no last-known-good
  document and always offers recovery.
- No feature module needs to import another feature's internal state.
- Long-running operations expose uniform progress/cancel/retry and never orphan
  threads or partial outputs.
- Adding a platform implementation does not require conditional code in domain
  or frontend feature modules.

## Risks, tradeoffs and alternatives

- Code generation can add build complexity; schema conformance tests are a
  lower-disruption alternative if generation proves brittle.
- Moving all metadata into SQLite would simplify queries but reduce portability
  and recoverability; retain file/sidecar truth until sync requirements justify
  a transactional database source of truth.
- Large refactors can stall product work; extract seams while delivering one
  roadmap feature and preserve characterization tests.

