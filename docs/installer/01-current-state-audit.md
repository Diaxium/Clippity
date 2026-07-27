# Clippity Installer — Current-State Audit

Status: Complete (2026-07-24)
Scope: `installer/` (the custom Clippity Setup wizard) and its seams into
`app/` (the Tauri-bundled application) and the root build scripts.

This is Phase 1 of the "Windows Setup & Maintenance Wizard" upgrade. It records
what exists **before** any change, so the architecture decision
([02-architecture-decision.md](02-architecture-decision.md)) and the
implementation that follows are grounded in fact rather than assumption. No
destructive refactoring was done to produce it.

---

## 1. What the installer is

Two distinct Windows delivery mechanisms coexist in this repository:

| Mechanism | Where | Technology | Status |
| --- | --- | --- | --- |
| **Tauri bundles** | `app/` → `build/msi`, `build/nsis` | Tauri v2 → WiX MSI + NSIS setup exe, updater plugin with a real minisign pubkey | Produced by `tauri build`; the app's own shipping installers |
| **Clippity Setup wizard** | `installer/` | A **second, custom Tauri v2 app** that embeds the application binary and paints its own install/modify/update/uninstall UI | The subject of this upgrade |

The custom wizard is a **layered Cargo workspace + React 19 frontend** that
mirrors the main app's shape:

```
installer/app/
├─ frontend/   React 19 + Vite + Tailwind 4, three flows (setup/maintenance/uninstall)
├─ shared/     @clippity/installer-shared — IPC wire contracts (TS)
└─ backend/
   ├─ crates/infra/      errors, logging, resolved paths
   ├─ crates/domain/     pure rules: plans, versions, sizing, progress (unit-tested)
   ├─ crates/platform/   Win32 elevation (real), registry + shortcuts (STUBBED)
   ├─ crates/services/   install/update/uninstall orchestration + manifest + payload
   └─ src-tauri/         one frameless window + thin Tauri commands
```

The dependency direction is strictly top-down
(`src-tauri → services → platform → domain → infra`), and `installer-domain`
is dependency-free and unit-tested. The design system (`theme.css`,
`globals.css`) is reused verbatim from the app; the wizard is dark-first.

**Delivery model:** the wizard ships the application *inside its own binary*.
`scripts/stage-installer-payload.mjs` copies the built `Clippity.exe` into
`installer/payload/` with a `payload.json` (exe name, version, size, SHA-256);
`crates/services/build.rs` compiles both in with `include_bytes!`.
`bundle.active` is therefore `false` — `tauri build` emits one self-contained
`Clippity Setup.exe` (~56 MB) that needs no network and no sibling files.

---

## 2. What actually works today (verified by reading the source)

These paths perform real side effects and/or are unit-tested:

| Capability | File | Notes |
| --- | --- | --- |
| **Payload embed + integrity check** | `services/payload.rs` | `include_bytes!`; `verify()` checks size + SHA-256 before writing anything to disk. Real. |
| **Payload write to disk** | `services/payload.rs::install_to` | `fs::write` into the destination; renames a locked existing `Clippity.exe` to `.old` first (so reinstall-over-running works). Real. |
| **Elevation detection** | `platform/windows/elevation.rs` | `OpenProcessToken` + `GetTokenInformation(TokenElevation)`. Real Win32. |
| **Elevated relaunch** | `platform/windows/relaunch.rs` + `services/elevation.rs` | `ShellExecuteW` `runas` verb, plan written to a temp handoff file, `--resume <file>` picked up on the elevated launch. Real; one wizard pass, one UAC prompt. |
| **Elevation policy** | `domain/install.rs::needs_elevation` | All-users scope, or a destination under `Program Files` / `ProgramData` / `Windows`, requires elevation; a writable per-user path does not. Unit-tested, incl. prefix-sibling and casing edge cases. |
| **Plan building & sizing** | `domain/install.rs::build_plan` | Required components force-included; disk estimate = components × 1.36. Unit-tested. |
| **Version comparison** | `domain/update.rs::compare_versions` | Dotted-numeric, missing-component-as-zero. Unit-tested. |
| **Removal summary** | `domain/uninstall.rs::summarize` | Removed/kept byte split; default keeps destructive user content. Unit-tested. |
| **Uninstall dir removal** | `services/uninstall_service.rs::remove_install_dir` | `fs::remove_dir_all` of the install dir; tolerates an already-absent dir. Real (but blunt — see §4). |
| **Progress streaming** | `src-tauri/app/commands.rs` + `domain/progress.rs` | Real Tauri events (`installer://progress`); single-operation guard prevents two ops racing. |
| **Preview fallback** | `frontend/state/wizardStore.ts` | Outside Tauri, the whole wizard runs a timed simulation so every screen is browser-previewable. |

The workspace **compiles clean** (`cargo check --workspace`, exit 0) and the
domain unit tests exist (run via a renamed binary — Windows blocks running an
exe named `installer_*` with `os error 740`; see the installer README).

---

## 3. What is stubbed (logs, no effect)

These are the highest-impact gaps: the wizard *appears* to register with
Windows but does not.

| Capability | File | Reality |
| --- | --- | --- |
| **Add/Remove Programs entry** | `platform/windows/registry.rs` | `write_uninstall_entry` / `remove_uninstall_entry` only `tracing::info!` — **no `RegCreateKeyEx`/`RegSetValueEx`**. Clippity never appears in Settings › Apps, and Windows has no `UninstallString` to run. |
| **Desktop / Start-menu shortcuts** | `platform/windows/shortcuts.rs` | `create_desktop_shortcut` / `remove_desktop_shortcut` only log — **no `IShellLinkW`/`IPersistFile`**. No `.lnk` is ever written. |
| **Start-at-login** | `platform/windows/shortcuts.rs::set_start_at_login` | Logs only — **no `Run`-key value**. |

Because the `UninstallString` the entry *would* carry points at
`"{install}\setup.exe" /uninstall`, and nothing copies the wizard into the
install directory, even a real registry write would reference a non-existent
uninstaller. Both halves are missing.

---

## 4. What is simulated (fake data / no-op)

| Area | File | Reality |
| --- | --- | --- |
| **Update check** | `services/update_service.rs::check` | Compares the installed string against this build's manifest version, but `download_bytes` (82.4 MB), `release_notes`, and `signature` are hardcoded. No update server. |
| **Update apply** | `services/update_service.rs::run` | Pure `pace()` sleeps — copies nothing, verifies nothing, backs up nothing, rolls back nothing. |
| **Product facts** | `services/manifest.rs::product` | Version hardcoded **`1.5.0`** while the real embedded payload is **`0.1.0`** (`payload/payload.json`). The manifest and the binary disagree. |
| **Component sizes / catalog** | `services/manifest.rs::components` | Seven components with invented sizes. **Selecting/deselecting a component changes only the displayed byte total** — the payload is a single monolithic exe, so "OCR engine", "GIF encoder", "Cloud sync" etc. are not independently installed, repaired, or removed. |
| **Data categories** | `services/manifest.rs::data_categories` | Six categories (app/shortcuts/cache/settings/credentials/content) with invented sizes; not correlated to any real on-disk path. |
| **Install status** | `commands.rs::get_install_status` | `last_updated` hardcoded to `2025-05-09T10:47:00Z`; channel always `Stable`. |
| **Modify** | `services/install_service.rs` (Modify kind) | Runs the *same* full-payload install checklist; there is no add/remove-component diff. |

---

## 5. Missing entirely (relative to the task's lifecycle requirements)

| Requirement | Present? | Notes |
| --- | --- | --- |
| **Installation detection** (not-installed / healthy / damaged / partial / upgrade / same / newer / reboot-pending) | No | The maintenance hub assumes an install exists; there is no probe correlating registry + manifest + on-disk exe. |
| **On-disk installation manifest / shared model** | No | Nothing records installed files, component ownership, integrity hashes, registry entries, shortcuts, scope, or an installation GUID. Uninstall works off a single default path, not a manifest. |
| **Repair** | No | No missing/corrupt-file detection, no restore. |
| **Real update** (channel, signed metadata, staging, downgrade protection, rollback, migration) | No | Simulated only. Note the app *already* has a Tauri updater — two update systems would conflict (see ADR). |
| **Reinstall** (preserve/reset/clean variants) | No | — |
| **Graceful shutdown IPC** to a running Clippity | No | Relies on renaming a locked exe; there is no request to the app to stop captures/recordings and exit its tray/overlay/workers. |
| **Restart Manager / locked-file handling / reboot cleanup** | No | No `RmStartSession`, no `MoveFileExW(MOVEFILE_DELAY_UNTIL_REBOOT)`, no pending-reboot reporting. |
| **Cleanup worker / self-removal** | No | An uninstaller cannot delete its own directory while running; there is no cleanup worker. |
| **Transactions / rollback / operation journal** | No | Each service walks a checklist; a failure aborts and leaves partial state with no journal to resume or reverse. |
| **Least-privilege elevated worker** | Partial | The *whole* wizard relaunches elevated; there is no narrow elevated worker with a restricted command schema. |
| **Conditional integrations** (URL protocol, file associations, App Paths, context menu, scheduled tasks, services, firewall, env vars) | No | Only shortcuts + Run key + ARP are modelled, and those are stubbed. |
| **CLI / silent operation / exit codes** | No | The wizard is launch-context (hash-route) driven; no `--install/--uninstall/--silent`, no documented exit codes. |
| **Structured logging & diagnostics export** | Partial | `tracing` to a `setup.log` path is initialised, but there is no per-operation structured journal and no diagnostic-package export. |
| **Signing** | Not in repo | No Authenticode configuration for the wizard, cleanup worker, or update packages (the app's Tauri updater has a minisign pubkey; the wizard has none). |

---

## 6. Risks, redundancy, and unsafe behavior

1. **Blunt uninstall.** `remove_install_dir` runs `fs::remove_dir_all` on the
   install directory unconditionally. If a user installed into a shared or
   pre-existing folder (the Options step is free-text), this can remove
   unrelated files. There is no manifest to delete only owned files, and no
   "unknown files remain" preservation path. **This is the single most
   dangerous behavior in the current code.**

2. **ARP would be orphaned.** If registry writes were switched on as-is, the
   `UninstallString` references a `setup.exe` that is never placed in the
   install dir — Windows would show an entry whose Uninstall button fails.

3. **Two update systems.** The app ships a Tauri updater (real pubkey); the
   wizard has its own (simulated) update flow. Shipping both invites
   divergent version state. The ADR must pick one owner.

4. **Manifest/payload version drift.** `product().version = "1.5.0"` vs
   payload `0.1.0`. Any detection or "is an update available" logic built on
   the manifest version is wrong today.

5. **No commit/verify boundary.** Install writes the payload and (would)
   register integrations with no post-write integrity re-check and no
   launch-test; a corrupted copy would still reach the "Complete" screen.

6. **Component fiction.** The UI presents seven independently selectable
   components, but the delivery is monolithic. Modify/Repair over "components"
   cannot be honest until either (a) the payload is decomposed into real
   component resources, or (b) the UI is scoped to what is truly separable
   (integrations, sidecars).

7. **`.old` backup never cleaned.** `install_to` leaves `Clippity.exe.old` in
   the install dir on a replace; nothing removes it after a successful commit.

None of these block the audit; they define the work.

---

## 7. Inventory: where each concern lives

- **Installer source:** `installer/app/backend/{crates,src-tauri}`, `installer/app/frontend`, `installer/app/shared`.
- **Tauri bundle config (wizard):** `installer/app/backend/src-tauri/tauri.conf.json` (`bundle.active:false`).
- **Tauri bundle config (app):** `app/backend/src-tauri/tauri.conf.json` (`bundle.active:true`, `targets:"all"`, updater pubkey).
- **Payload embed:** `installer/payload/`, `installer/app/backend/crates/services/build.rs`, `scripts/stage-installer-payload.mjs`.
- **Registry-writing code:** `installer/app/backend/crates/platform/src/windows/registry.rs` (stub), `.../entry.rs` (value model).
- **Shortcuts / startup:** `.../windows/shortcuts.rs` (stub).
- **Elevation:** `.../windows/elevation.rs` (real), `.../windows/relaunch.rs` (real), `services/elevation.rs` (handoff).
- **URL protocol / file assoc / context menu / tasks / services / firewall:** none.
- **Updater code:** `services/update_service.rs` (simulated); app-side Tauri updater in `app/.../tauri.conf.json`.
- **App shutdown IPC:** none in the installer; the app's own single-instance/tray behavior lives in `app/backend/src-tauri`.
- **User-data locations (installer view):** `infra/paths.rs` — `%APPDATA%\Clippity`, `%LOCALAPPDATA%\Clippity`, log `…\logs\setup.log`.
- **Installer logs:** `infra/logging.rs` (tracing init).
- **Build/release scripts:** `scripts/collect-build.mjs`, `scripts/stage-installer-payload.mjs`, `scripts/build-portable.mjs`; `installer/scripts/collect-build.mjs`.

---

## 8. Compatibility requirements for existing users

- The app's shipped installers today are **Tauri MSI + NSIS** (`build/`). Any
  existing real-world install (if the product had shipped) would be registered
  by *those*, under `com.clippity.app`, not by the custom wizard. The wizard's
  ARP subkey is `…\Uninstall\Clippity` (a plain name), which does **not**
  collide with an MSI ProductCode GUID or the NSIS `{identifier}` key — so the
  wizard cannot currently detect or maintain an MSI/NSIS-installed copy. Cross-
  detection of legacy installs is a required capability the wizard lacks.
- Data lives under a single `Clippity` folder in `%APPDATA%`/`%LOCALAPPDATA%`
  (matches `clippity_infra::paths::DATA_DIR_NAME`). This convention is stable
  and must be preserved so user content survives any installer change.

---

## 9. Verdict

The wizard is a **high-quality UI prototype with a real payload-copy core and
real elevation**, wrapped around **stubbed Windows integrations** and a
**simulated update/maintenance layer**. It is *not* yet a Windows installation
system: it does not register with Windows, cannot be uninstalled by Windows,
keeps no installation state, has no detection, repair, rollback, locked-file, or
self-removal capability, and its uninstall is unsafe on a shared directory.

The **safe, high-value path** is to harden the existing engine into a real one —
replace the stubs with real Win32, add an on-disk installation model + detection,
make uninstall manifest-driven, and add the transaction/self-removal/locked-file
scaffolding — while documenting a strategic migration of the *transactional
install core* onto Windows Installer (MSI/WiX) where its guarantees are hard to
reproduce by hand. That trade-off is decided in
[02-architecture-decision.md](02-architecture-decision.md).
