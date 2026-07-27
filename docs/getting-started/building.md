# Building

## Production frontend

```bash
pnpm build
```

Type-checks `@clippity/shared`, then type-checks and bundles the frontend
into `app/frontend/dist` (Vite). This is what the Tauri build embeds.

## Native desktop bundle / installer

```bash
pnpm tauri:build
```

Runs the frontend build first (Tauri's `beforeBuildCommand`), then compiles
the Rust workspace in `--release` and produces the platform bundle. On
Windows the artifacts land under
`app/backend/src-tauri/target/release/bundle/` (plus the raw
`Clippity.exe` in `target/release/`).

### Release profile

Release settings live once at the Cargo workspace root
([`app/backend/Cargo.toml`](../../app/backend/Cargo.toml)):

```toml
[profile.release]
opt-level = 3
lto = "thin"
codegen-units = 1
strip = "symbols"
```

These favour a small, fast binary over compile speed — expect a release
build to take considerably longer than a `cargo check`. See
[development/performance.md](../development/performance.md) for measured
build times.

## Shipping everything

```bash
pnpm dist
```

Builds every distributable, in dependency order:

| Step                   | What it does                                                                |
| ---------------------- | --------------------------------------------------------------------------- |
| `pnpm tauri:build`     | Builds the app and collects its artifacts into `build/`                      |
| `pnpm portable`        | Assembles the portable folder + zip into `build/portable/`                   |
| `pnpm stage:payload`   | Copies `build/clippity.exe` into `installer/payload/`                        |
| `pnpm installer:build` | Compiles that payload into the installer, producing `installer/build/`       |

Each step also runs standalone, provided the one before it has.

### The artifacts

| Path                                             | What to hand out                    |
| ------------------------------------------------ | ----------------------------------- |
| `installer/build/Clippity Setup.exe`             | **The installer.** One self-contained file |
| `build/portable/Clippity-<version>-portable.zip` | **The portable build.** Unzip and run |
| `build/msi/`, `build/nsis/`                      | Tauri's stock bundles, if you want them |

### The installer payload

The installer under [`installer/`](../../installer) is a **separate pnpm
workspace** with its own lockfile — the root's `pnpm -r` and `--filter`
never reach it, which is why the chain shells into the directory rather
than filtering a package. Run `pnpm install` inside `installer/` once
before the first build.

`pnpm stage:payload` is the only seam between the two projects. It copies
the built app into `installer/payload/` and records its version, size, and
SHA-256 in `payload.json`; the installer's `crates/services/build.rs`
compiles both into the binary with `include_bytes!`, and the wizard's
"Verifying" step checks the hash before writing anything to disk.

Building the installer without staging a payload still succeeds — the
build script emits `None` and warns. It then fails at install time with a
message naming the staging step, and `collect-build` warns that the exe is
too small to contain an application. `pnpm dist` handles the ordering.

### The portable build

A portable Clippity is the same binary as the installed one. The only
difference is the `Clippity.portable` marker file beside it, which
[`clippity_infra::paths::portable_root`](../../app/backend/crates/infra/src/paths.rs)
looks for. With the marker present, settings, the library database,
captures, caches, and the WebView2 profile all live in a `Data` folder
next to the executable — so it runs from a USB stick and writes nothing
elsewhere on the machine. Deleting the marker turns the same binary back
into a normal installed app.

Three boot paths resolve data roots (`AppPaths::resolve`, the WebView2
data directory, and the pre-Tauri GPU-preference read), and all three go
through that one function, so portable mode can't half-apply.
