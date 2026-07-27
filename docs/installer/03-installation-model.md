# Installation Model, Directory & Registry Ownership

Status: Implemented (core) — 2026-07-24
Covers task Phases 3, 4, 5, 11.

## The authoritative manifest

The single source of truth for an installation is `install-state.json`, written
to the maintenance directory on install and read by detect / modify / repair /
uninstall. It is defined in
[`installer_domain::state::InstallationManifest`](../../installer/app/backend/crates/domain/src/state.rs)
and persisted by
[`installer_services::state_store`](../../installer/app/backend/crates/services/src/state_store.rs).

```jsonc
{
  "schemaVersion": 1,
  "productId": "com.clippity.app",
  "installationId": "<sha256-derived guid>",
  "version": "0.1.0",
  "architecture": "x64",
  "scope": "current-user" | "all-users",
  "installDirectory": "…",
  "maintenanceDirectory": "…",
  "installDate": "2026-07-24T…Z",
  "installedComponents": ["core", …],
  "files":          [ { "path", "sha256", "bytes", "component", "mutable" } ],
  "directories":    [ "<install dir>", "<maintenance dir>" ],
  "registryEntries":[ { "hive", "subkey", "valueName" } ],
  "shortcuts":      [ { "path", "target" } ],
  "startAtLogin": false
}
```

Design points that make it safe and MSI-adjacent:

- **Every recorded action has a known inverse.** A file → delete it; a shortcut
  path → delete that `.lnk`; a registry record → delete that value/subkey. The
  uninstaller reverses *exactly* what is recorded and nothing else.
- **`sha256` per immutable file** backs repair's corruption detection;
  `mutable: true` marks files the app rewrites at runtime, excluded from repair.
- **`schemaVersion`** — a reader that finds a higher version than it understands
  refuses to act (routes to a newer wizard) rather than guessing. Detection has
  a `peek_schema_version` that recognises this even when the rest of the shape
  changed incompatibly.
- **Ownership marker.** The Add/Remove Programs key also carries a private
  `ClippityInstallerSchema` DWORD. Detection uses its presence to tell an entry
  *this wizard wrote* from a foreign (MSI/NSIS/legacy) `Uninstall\Clippity` key,
  which routes to migration instead of a happy path.
- **`installationId`** is stable per install (derived from install path + first
  install time), giving the documented MSI/WiX target a deterministic key to
  adopt or supersede a manifest-recorded install.

> Honest scope note: the delivery today is a **single monolithic `Clippity.exe`**
> payload, so `files` currently records one `core` file and `installedComponents`
> records the selected component ids without independently installed per-component
> resources. The model is component-shaped so that when the payload is decomposed
> (or moved to an MSI with real features), modify/repair become truthful without
> a model change. This is the only place the UI's seven-component picker is not
> yet fully backed by independent on-disk resources.

## Directory ownership (Phase 4)

Resolved by
[`installer_infra::paths`](../../installer/app/backend/crates/infra/src/paths.rs).
Every path is classified so uninstall knows what it may remove.

| Path | Class | Default uninstall |
| --- | --- | --- |
| `C:\Program Files\Clippity\` (machine) or `%LOCALAPPDATA%\Programs\Clippity\` (user)* | Installer-owned binaries | Removed (owned files only, dir removed if empty) |
| `%PROGRAMDATA%\Clippity\maintenance\` (machine) / `%LOCALAPPDATA%\Clippity\maintenance\` (user) | Installer-owned maintenance state (manifest, uninstaller copy, logs) | Removed last (self-removal / reboot fallback) |
| `%LOCALAPPDATA%\Clippity\` | Generated cache / thumbnails | Optional, normally selected |
| `%APPDATA%\Clippity\` | User preferences / settings | Optional, **off** by default unless "remove settings" |
| Screenshots / recordings / GIFs / projects / exports (user-chosen folders) | **User-owned content** | **Never** removed by default; explicit opt-in + confirmation only |

\* The Options step is free-text today and defaults to `C:\Program Files\Clippity`.
The per-user no-elevation default (`%LOCALAPPDATA%\Programs\Clippity`) is a
recommended follow-up; the elevation policy already supports it.

**Hard safety rules enforced in code**
([`uninstall_service`](../../installer/app/backend/crates/services/src/uninstall_service.rs)):

- Manifest-driven uninstall deletes only recorded owned files, then removes a
  directory **only when it is empty** (`remove_dir_if_empty`). Unknown files are
  preserved and their location logged. Proven by the
  `owned_files_are_removed_but_unknown_files_are_preserved` unit test.
- The blunt `remove_dir_all` path survives **only** as a legacy fallback for a
  pre-manifest install with no recorded file list, and even then targets only
  the resolved `install_dir`, never a user-typed data folder.
- The maintenance dir lives **outside** the install dir, so uninstall can delete
  the install dir freely and the maintenance exe self-removes afterward.

## Registry ownership (Phase 5)

Written by
[`installer_platform::windows::registry`](../../installer/app/backend/crates/platform/src/windows/registry.rs)
via the audited helpers in `regutil.rs`.

- **Hive by scope:** `HKCU` for per-user, `HKLM` for all-users
  (`RegistryHive::for_scope`). Uninstall removes from the same hive it wrote.
- **Add/Remove Programs** subkey `…\CurrentVersion\Uninstall\Clippity` with the
  Microsoft-documented value set: `DisplayName`, `DisplayVersion`, `Publisher`,
  `DisplayIcon` (installed exe, `,0`), `InstallLocation`, `InstallDate`
  (`YYYYMMDD`), `UninstallString`, `QuietUninstallString`, `ModifyPath`,
  `URLInfoAbout`, `HelpLink`, `EstimatedSize` (DWORD KiB), `NoModify=0`,
  `NoRepair=0`, plus the private `ClippityInstallerSchema` marker.
- **Uninstall/Modify strings point at the maintenance exe**
  (`clippity-maintenance.exe --uninstall` / `--modify`), which is placed on disk
  *before* the entry is written — so the Settings buttons actually work.
- **We deliberately do NOT set `WindowsInstaller` or `SystemComponent`.** This is
  not an MSI; claiming so would mislead Windows and could hide the entry. This
  respects the task's "do not duplicate MSI-owned registration manually" rule —
  we register as a plain, honest ARP entry, not a fake MSI.
- **Start-at-login** is a single per-user value under
  `…\CurrentVersion\Run\Clippity` (always HKCU — a user preference, never
  machine policy), added/removed by the toggle and recorded in the manifest.

## Integrations installed conditionally (Phase 11)

Only integrations Clippity actually uses are created:

| Integration | Status |
| --- | --- |
| Start-menu shortcut | **Implemented** (always) |
| Desktop shortcut | **Implemented** (opt-in) |
| Start-at-login (`Run` key) | **Implemented** (opt-in, per-user) |
| Add/Remove Programs registration | **Implemented** |
| URL protocol (`clippity://`) | Documented, not yet wired — must treat protocol data as untrusted |
| File associations | Modelled in the Options step; registration not yet wired — must not force default-app |
| App Paths / context menu / scheduled tasks / services / firewall / env vars | **Not created** — Clippity has no current need; adding registry noise "because we can" is explicitly avoided |

Anything added later must record a matching manifest entry with a reversal, per
the model above.
