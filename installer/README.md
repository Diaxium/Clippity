# Clippity Setup

The **install / modify / update / repair / uninstall** wizard for Clippity.

A standalone project that mirrors the main Clippity app's structure and design
system. Every screen follows the design boards in [`design/`](design/):
[Setup](design/Setup-workflow.png), [Modification](design/Modification-workflow.png),
and [Uninstaller](design/Uninstaller-workflow.png).

## Layout

Same shape as the main app — a pnpm + Cargo workspace under `app/`:

```
installer/
├─ app/
│  ├─ frontend/        React 19 + Vite + Tailwind 4 wizard UI
│  ├─ shared/          @clippity/installer-shared — IPC wire-format contracts
│  └─ backend/
│     ├─ crates/
│     │  ├─ infra/     errors, logging, resolved paths
│     │  ├─ domain/    pure rules: plans, versions, sizing, progress (unit-tested)
│     │  ├─ platform/  Win32 shortcuts, registry (Add/Remove Programs), elevation
│     │  └─ services/  install / update / uninstall orchestration + manifest
│     └─ src-tauri/    the single wizard window + thin Tauri commands
├─ payload/           the staged Clippity.exe, compiled into the binary
├─ design/            the reference design boards
├─ package.json       root workspace scripts
└─ pnpm-workspace.yaml
```

The backend follows the same top-down layering as the app
(`src-tauri → services → platform → domain → infra`); crossing a layer is only
ever downward, so `installer-domain` stays pure and unit-testable.

## The three flows

The wizard runs one of three flows, chosen by the launch context (hash route in
preview):

| Flow           | Route           | Steps                                                                   |
| -------------- | --------------- | ----------------------------------------------------------------------- |
| **Setup**      | `#/setup`       | Welcome → Options → Components → Review → Installing → Complete          |
| **Maintenance**| `#/maintenance` | Hub → Check for updates → Update available → Modify → Applying → Complete|
| **Uninstall**  | `#/uninstall`   | Hub → Prepare → Choose data → Review removal → Uninstalling → Complete   |

Maintenance and Uninstall share the maintenance **hub** (Update / Modify /
Repair / Uninstall). Uninstall keeps destructive user content (captures,
projects, credentials) unless explicitly opted in — removal of those is off by
default.

A small **Preview** switcher (bottom center) jumps between the three entry
points; in a shipping build the flow is fixed at launch.

## Develop

```bash
pnpm install
pnpm dev              # Vite dev server on http://localhost:1430
pnpm tauri:dev        # run inside the Tauri shell
```

The frontend degrades gracefully outside Tauri: window controls, the folder
picker, and the backend commands become no-ops / a local simulation, so the
whole wizard is previewable in a plain browser. A dev-only `?step=<id>` query
deep-links any screen; `window.__wizard` exposes the store for debugging.

## Verify

```bash
pnpm build                    # tsc + vite build (frontend + shared)
pnpm check                    # typecheck all JS packages
pnpm cargo:test               # domain unit tests (see note below)
pnpm cargo:check              # compile the whole Rust workspace
```

> **Note (Windows):** `cargo test` binaries are named `installer_*` and Windows'
> UAC installer-detection heuristic blocks running them (`os error 740`). Copy a
> built test binary to a name without `install`/`setup` to run it, e.g.
> `cp target/debug/deps/installer_domain-*.exe target/debug/deps/dom.exe && ./target/debug/deps/dom.exe`.

## The bundled payload

The installer ships the application *inside its own binary* — no download
at install time, and no sibling files. `payload/` holds the staged
`Clippity.exe` plus a `payload.json` recording its version, size, and
SHA-256; [`crates/services/build.rs`](app/backend/crates/services/build.rs)
compiles both in with `include_bytes!`.

That is why **Tauri bundling is switched off** (`bundle.active: false` in
`tauri.conf.json`). `tauri build` emits one executable that needs nothing
beside it, and `scripts/collect-build.mjs` lifts it out as
`build/Clippity Setup.exe` — around 56 MB, the wizard plus the app.
Wrapping that in an msi or nsis would only be an installer for the
installer. The `icon` config still applies: `tauri-build` embeds the
`.ico` into the exe regardless of bundling.

Fill `payload/` from the **app** workspace, which owns the built binary:

```bash
pnpm dist
```

That builds the app, stages the payload, then builds this project.
Running `pnpm tauri:build` here alone reuses whatever payload was last
staged.

At install time `installer_services::payload` verifies the embedded bytes
against the manifest (the "Verifying" step) and writes them to the
destination (the "Installing files" step). A build with no payload staged
still compiles — the build script emits `None` and warns — and then fails
at Verifying with a message naming the staging step.

## Elevation

The wizard starts unelevated. `installer_domain::install::needs_elevation`
decides per plan: an all-users install, or a destination under `Program
Files`, `ProgramData`, or `Windows`, needs administrator rights; anywhere
the user can already write does not.

When it is needed, the Review step writes the plan to a handoff file,
relaunches the installer under the `runas` verb with `--resume <file>`,
and closes. The elevated copy reads the plan back and jumps straight to
the Installing step — so the user answers the wizard once and sees at most
one UAC prompt. Declining leaves them on Review with their selections
intact.

A per-user install into a writable folder never prompts at all.

## Design system

The frontend reuses the main app's `theme.css` / `globals.css` design tokens
verbatim — the coral `--color-accent`, glassmorphic surfaces, and the same
radius / shadow / motion scales. It is **dark-first** to match the design
boards, though the light token set still resolves.
