# Testing

## Everything

```bash
pnpm test        # Vitest (JS) + cargo test (Rust workspace)
pnpm test:js     # Vitest only — fast
```

## Frontend (Vitest + Testing Library)

- Config: [`app/frontend/vitest.config.ts`](../../app/frontend/vitest.config.ts)
  (jsdom environment, `src/test/setup.ts`).
- Tests live next to the code they cover as `*.test.ts` / `*.test.tsx`.
- Run one package: `pnpm --filter clippity-frontend test`; watch mode:
  `pnpm --filter clippity-frontend test:watch`.

The IPC clients are the mock seam: `services/tauri/client.ts`'s `invoke` is the
one place tests stub, so a component test never needs a live Tauri window
(`isTauriContext()` is false under Vitest).

## Backend (cargo test)

```bash
pnpm cargo:test        # or: cargo test --workspace --manifest-path app/backend/Cargo.toml
```

`domain` is designed to be unit-testable without a desktop session — its rules
(naming templates, geometry, palette/enhance math, vision post-processing) have
`#[cfg(test)]` tests that need no Tauri, filesystem, or window. Scope to one
crate with `cargo test -p clippity-domain`.

## What to test where

- Pure rules and wire-shape logic → `clippity-domain` unit tests.
- Component behaviour and hooks → Vitest in the frontend.
- IPC contract drift → caught by `pnpm check` (the frontend type-checks against
  `@clippity/shared`).
