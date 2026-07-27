# 0030 — Root-level pnpm + Cargo workspace restructure

Status: Accepted (2026-07-22)

## Context

The project had grown an ad-hoc layout. The pnpm workspace root lived *inside*
`app/frontend/` (which held `pnpm-workspace.yaml`, `pnpm-lock.yaml`, a stray
`package-lock.json`, and `node_modules`). The Rust backend was a **single
crate** at `app/backend/`. There was no shared contract package, and `docs/`
was a flat pile of ADRs, roadmaps, keybind notes, and a UX-review image dump.

Every workflow forced a `cd` into a nested directory
(`cd app/frontend && npm …`, `cd ../backend && tauri …`), and each app-layer
Rust edit recompiled the whole single crate — including the slowest
dependencies (`ort`/ONNX, bundled SQLite, the `windows` crate).

## Decision

Restructure into one **root-level workspace** — a single pnpm workspace and a
single Cargo workspace — with these load-bearing choices:

1. **Root is the workspace root.** `package.json`, `pnpm-workspace.yaml`, the
   one `pnpm-lock.yaml`, and `node_modules` live at the top. Every dev command
   runs from the root via pnpm scripts + `--filter`; no `cd` is ever required.

2. **A type-only shared package.** IPC wire contracts, previously inlined in
   each `services/tauri/clients/*.ts`, move to `@clippity/shared`
   (`app/shared/src/contracts/*`). Clients re-export them, so call sites are
   unchanged. The frontend depends on it via `workspace:*`.

3. **The backend becomes a Cargo workspace** of layered crates —
   `clippity-infra`, `clippity-domain`, `clippity-platform`,
   `clippity-vision`, `clippity-services`, and the `src-tauri` app crate — in a
   strict top-down DAG. Two upward edges from the old single crate were
   resolved so the DAG holds:
   - the event-name constants + `emit` helper moved from `app::events` down to
     `clippity-infra::events` (9 services emitted through it);
   - the system tray, which legitimately needs the whole `AppState`, stays in
     the app crate (`src-tauri/src/tray_service.rs`) rather than in
     `clippity-services`.

4. **Shared Cargo config is declared once** at the workspace root
   (`[workspace.dependencies]`, `[workspace.package]`, `[profile.release]`).

5. **Docs reorganized** into `getting-started/ architecture/ development/
   product/ decisions/`, with a root index and every root command documented in
   `development/commands.md`.

## Consequences

- Install / dev / build / test / lint all run from the root. A clean checkout
  builds with documented root commands only.
- The heavy compilers are quarantined: `ort` + `ndarray` in `clippity-vision`,
  bundled SQLite in `clippity-services`, the `windows` crate in
  `clippity-platform` + `clippity-services`. An edit to command wiring or
  `AppState` recompiles only `src-tauri`, leaving the slow leaves cached.
- **Removed dependency:** the `zip` crate — declared in the old `Cargo.toml`
  but unused in the source (confirmed by a clean `cargo check` without it).
- Frontend imports are unchanged: the clients re-export the contracts, so the
  ~1200-test Vitest suite and the strict type-check pass without touching
  feature code.
- One-time cost: contracts and Rust modules had to be relocated and their
  `crate::` paths rewritten to crate names. Verified end-to-end (see
  [../development/performance.md](../development/performance.md) for measured
  build times).

## Alternatives considered

- **Keep the backend as one crate, add only the workspace shell.** Rejected:
  it wouldn't deliver the parallel/independent compilation that motivated the
  split, and the mandated layout calls for `crates/` + `src-tauri/`.
- **Split `services` further into one crate per service.** Rejected as
  gratuitous — the services are cohesive and share helpers (`capture_io`,
  `sidecar`); per-service crates would add churn and inter-crate plumbing for
  no build-time gain over the layer split.
- **Move shared UI utilities (e.g. `cn`, `logger`) into `@clippity/shared`
  too.** Rejected: those are frontend-internal and used in hundreds of files;
  moving them is high-churn with no architectural payoff. The shared package
  stays lightweight — wire contracts only.
