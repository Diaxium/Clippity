# IPC & shared contracts

Frontend ↔ backend communication is typed end to end. There is one source of
truth for each wire shape, and a single place each side funnels through.

## The contract package

[`@clippity/shared`](../../app/shared) (`app/shared/src/contracts/*`) holds the
**wire-format types** — one module per backend domain (capture, overlay,
library, settings, models, …), re-exported from a barrel. It is **type-only**
and framework-agnostic: no React, no Tauri, no runtime code, so it adds nothing
to the bundle.

These types mirror the Rust `domain::*` structs, which use
`#[serde(rename_all = "camelCase")]`. **When a payload changes, update both**
the Rust `domain` type and the matching `app/shared` contract.

## Frontend side

- `services/tauri/client.ts` — the typed `invoke<TResult, TArgs>` wrapper.
  Every command call funnels through it, so failures are logged once and
  surfaced as `TauriCommandError` with a stable `.code`.
- `services/tauri/events.ts` — `EVENT_NAMES` (kept in lock-step with the Rust
  `clippity-infra::events::names`) and the `on(...)` subscription helper.
- `services/tauri/clients/<domain>.ts` — one typed function per command +
  event, re-exporting that domain's contracts from `@clippity/shared` so call
  sites keep importing types from the client module.

## Backend side

- `clippity-infra::events` — the canonical event-name constants and the
  `emit` helper. Services emit through it without depending on the app crate.
- `domain::*` — the serde structs that define the wire shapes.
- `app::commands` (in `src-tauri`) — thin `#[tauri::command]` handlers that
  validate via `domain`, call a service for the I/O, and return a serializable
  result. The `AppError` type serializes to `{ code, message }`, which the
  frontend's `TauriCommandError` consumes.

## Keeping the two in sync

Three things must agree:

1. **Event names** — `clippity-infra::events::names::*` ⇄
   `services/tauri/events.ts` `EVENT_NAMES`.
2. **Wire types** — Rust `domain::*` ⇄ `@clippity/shared` contracts.
3. **Command names** — the string in `#[tauri::command]` / the `invoke_handler`
   list ⇄ the string passed to `invoke(...)`.

`pnpm check` type-checks the whole frontend against `@clippity/shared`; a
contract that drifts from its consumers fails there.
