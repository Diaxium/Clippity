# Performance

This page covers **build-time** characteristics of the workspace. For
**runtime** profiling of the app, see the archived
[performance-audit-log](performance-audit-log.md) and
[devtools-performance-debug-report](devtools-performance-debug-report.md), and
the [performance roadmap](../roadmaps/performance.md).

## Why the crate split helps build time

The old backend was a single Rust crate: any change recompiled everything,
including the three slowest dependencies. The workspace quarantines them into
separate compilation units that build in parallel and cache independently:

| Slow dependency | Crate it now lives in |
| --- | --- |
| `ort` (ONNX Runtime) + `ndarray` | `clippity-vision` |
| bundled SQLite (`rusqlite`) | `clippity-services` |
| the `windows` crate | `clippity-platform` + `clippity-services` |

An edit to command wiring or `AppState` recompiles only `src-tauri`; the heavy
leaves stay cached. Dependency versions are declared once in
`[workspace.dependencies]`, so there is no accidental version duplication.

## Measured build times

Measured on the reference Windows dev machine (warm Cargo registry; the `ort`
crate downloads its ONNX binaries during the first vision-crate compile).

| Step | Command | Time |
| --- | --- | --- |
| Frontend production build | `pnpm build` (Vite, 2472 modules) | ~13 s |
| Frontend dev server ready | `pnpm dev` | ~1 s |
| Reproducible install (warm) | `pnpm install --frozen-lockfile` | <1 s |
| Rust check — 5 lower crates, cold target | `cargo check` (incl. ONNX download) | ~2 min |
| Rust check — add `src-tauri`, deps cached | `cargo check --workspace` | ~20 s |
| Rust **release** build + bundle (MSI + NSIS) | `pnpm tauri:build` | ~9.5 min (≈9m release compile + frontend build + bundling) |

The dev-vs-release gap is expected: the release profile trades compile time
for a small, fast binary (`lto = "thin"`, `codegen-units = 1`,
`strip = "symbols"`). Use `pnpm check` / `pnpm cargo:check` for the fast
inner loop and reserve `tauri:build` for producing artifacts.

## Removed / pruned dependencies

- **`zip`** — declared in the old single-crate `Cargo.toml` but unused in the
  source; dropped. Confirmed by a clean workspace `cargo check` without it.

Per-crate dependency sets were derived from actual usage, so each crate pulls
only what it needs (e.g. `clippity-domain` compiles against just `serde` +
`image`, not the whole capture/imaging stack).

## Tips

- Scope Rust work to one crate: `cargo check -p clippity-domain`.
- Scope JS work with pnpm filters: `pnpm --filter clippity-frontend test`.
- `pnpm check:js` / `pnpm test:js` skip the Rust compile entirely for
  frontend-only changes.
