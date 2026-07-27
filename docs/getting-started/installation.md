# Installation

From the repository root (`restructure/`):

```bash
pnpm install
```

That installs every JavaScript workspace package and links the internal
packages (`@clippity/shared` is symlinked into the frontend). There is a
single lockfile at the root — [`pnpm-lock.yaml`](../../pnpm-lock.yaml).

## Reproducible installs

CI and clean checkouts should use the frozen lockfile so the install fails
loudly if the lockfile is out of date:

```bash
pnpm install --frozen-lockfile
```

## Rust dependencies

Cargo dependencies resolve on first `cargo`/`tauri` invocation from the
workspace at [`app/backend`](../../app/backend); there is nothing extra to
install by hand. See [prerequisites](prerequisites.md) for the first-build
network requirements (`ort` binaries).

## What got installed where

- Root `node_modules/` — shared dev tooling (TypeScript, ESLint, Prettier).
- `app/frontend/node_modules/` — React/Vite/Vitest and the `@clippity/shared`
  symlink.
- `app/backend/src-tauri/node_modules/` — the Tauri CLI.

Next: [development.md](development.md).
