# Commands

Every command below runs from the **repository root** (`restructure/`). You
never need to `cd` into a package. Commands are pnpm scripts defined in the
root [`package.json`](../../package.json); the Rust ones proxy into the Cargo
workspace at [`app/backend`](../../app/backend).

## Setup

| Command | What it does |
| --- | --- |
| `pnpm install` | Install all JS workspace deps and link internal packages. |
| `pnpm install --frozen-lockfile` | Reproducible install (CI); fails if the lockfile is stale. |

## Develop

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the Vite dev server for the frontend at `http://localhost:1420` (browser only, no native shell). |
| `pnpm tauri:dev` | Launch the full desktop app — Vite + the Tauri shell. Rebuilds Rust on change. |

## Build

| Command | What it does |
| --- | --- |
| `pnpm build` | Type-check `@clippity/shared`, then type-check + production-build the frontend into `app/frontend/dist`. |
| `pnpm tauri:build` | Produce the native desktop bundle / installer (runs the frontend build first via Tauri's `beforeBuildCommand`). |
| `pnpm preview` | Serve the built frontend for a local production preview. |

## Quality gates

| Command | What it does |
| --- | --- |
| `pnpm check` | Recursive `check` — TypeScript type-check (`@clippity/shared`, frontend) **and** `cargo check` of the whole Rust workspace. |
| `pnpm check:js` | Type-check only the JS packages (fast; no Rust compile). |
| `pnpm test` | Recursive `test` — Vitest (JS) **and** `cargo test` (Rust workspace). |
| `pnpm test:js` | Vitest only (fast). |
| `pnpm lint` | Recursive `lint` — ESLint (JS) and `cargo clippy` (Rust). |
| `pnpm lint:fix` | ESLint with `--fix`. |
| `pnpm format` | Prettier (JS) and `cargo fmt` (Rust). |

## Rust-only shortcuts

These target the Cargo workspace directly from the root without a `cd`:

| Command | What it does |
| --- | --- |
| `pnpm cargo:check` | `cargo check --workspace` over `app/backend`. |
| `pnpm cargo:build` | `cargo build --workspace --release`. |
| `pnpm cargo:test` | `cargo test --workspace`. |
| `pnpm cargo:clippy` | `cargo clippy --workspace`. |
| `pnpm cargo:fmt` | `cargo fmt` across the workspace. |

To scope a Rust command to a single crate, use Cargo's `-p` flag, e.g.
`cargo check -p clippity-domain --manifest-path app/backend/Cargo.toml`.

## Scoping with pnpm filters

Any package script can be run in isolation with `--filter`:

```bash
pnpm --filter clippity-frontend test        # just the frontend suite
pnpm --filter @clippity/shared check        # just the shared contracts
pnpm --filter clippity-tauri tauri:build    # just the native build
```

Workspace package names: `clippity-frontend`, `@clippity/shared`,
`clippity-tauri`. See [architecture/project-structure.md](../architecture/project-structure.md).
