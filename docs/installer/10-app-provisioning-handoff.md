# 10 — Installer → application handoff (`install-config.json`)

How the choices a user makes in the wizard reach the running application.

Added 2026-07-25, after the maintenance-engine passes. Everything before this
was about making the *installer* honest about what it put on the machine; this
is about making the *application* honest about what the user asked for.

## The problem

The wizard asks two kinds of question:

- **Options step** — create a desktop shortcut, start at login, enable
  automatic updates, help improve Clippity, register file associations.
- **Components step** — capture integration, file associations, startup
  helper, GIF encoder, OCR engine, cloud sync.

Only two of those answers used to survive the wizard closing: the desktop
shortcut (a `.lnk` exists or it doesn't) and start-at-login (a `Run` value).
Everything else evaporated. The consequences were concrete:

- A user who unchecked **OCR engine** still found Grab Text on the Custom
  panel, fully armed.
- A user who unchecked **GIF encoder** still had a GIF launcher card and a
  `Ctrl+4` hotkey.
- A user who unchecked **capture integration** still got an OS-global capture
  hotkey registered at startup.
- **Enable automatic updates** and **Help improve Clippity** were bound to
  nothing whatsoever — the app had no such settings to bind to.
- The **Modify** step opened on `InstallOptions::default()`, so pressing
  "Apply changes" silently rewrote the user's original choices with defaults.

## The contract

A small versioned JSON document, written into the **install directory beside
`Clippity.exe`**:

```json
{
  "schemaVersion": 1,
  "productId": "com.clippity.app",
  "version": "1.5.0",
  "writtenAt": "2026-07-25T10:00:00Z",
  "scope": "current-user",
  "components": ["core", "capture", "assoc", "startup"],
  "preferences": {
    "desktopShortcut": true,
    "startAtLogin": false,
    "automaticUpdates": true,
    "helpImprove": true,
    "fileAssociations": true
  }
}
```

Beside the executable, because the app can then find it with nothing but
`current_exe()` — no registry lookup, no knowledge of the installer's
maintenance directory, and no dependence on paths that differ between
per-user and all-users installs.

**Deliberately not the installation manifest.** `install-state.json` is a
removal ledger (every file, registry value and shortcut, so uninstall can
reverse exactly those); this is a statement of what the user asked for. Keeping
them separate means the app never parses a schema it doesn't own, and the
ledger can change shape without breaking every installed copy of Clippity.

| Side | Module |
| --- | --- |
| Writer | `installer_domain::provisioning` (types) + `installer_services::provisioning_store` (I/O) |
| Reader | `clippity_domain::provisioning` (types + rules) + `clippity_services::provisioning_service` (I/O) |
| Wire mirror | `installer/app/shared/.../install.ts`, `app/shared/.../provisioning.ts` |

## Lifecycle

| Operation | What happens to the document |
| --- | --- |
| Install | Written from the committed manifest; recorded as an owned file (component `config`) in the manifest and in the transaction journal. |
| Modify | Same code path as install, so it is rewritten from the new selection. |
| Repair | Regenerated from the manifest whenever it is missing or has drifted. Not hash-verified — it is derived, so it is rewritten rather than compared. |
| Rollback | Removed with every other recorded action of the failed operation. |
| Uninstall | Removed as one of the manifest's owned files — no special case. |

To make repair and Modify able to reconstruct it, `InstallationManifest`
gained a `preferences` block (`automaticUpdates`, `helpImprove`,
`fileAssociations` — the three that leave no other trace on the machine). It is
additive and `#[serde(default)]`, so no schema bump: a manifest written before
the field existed reads as the shipped defaults, which is what those installs
actually chose.

`InstallationManifest::installed_options()` reconstructs the whole Options-step
selection, which is what the new `get_installed_configuration` command feeds to
the Modify step.

## How the app applies it

Two different kinds of answer, treated differently on purpose.

**Components are capabilities.** Resolved at startup into
`domain::provisioning::Capabilities` and enforced wherever the feature is
reachable:

| Component | Capability | Enforcement |
| --- | --- | --- |
| `capture` | `globalHotkeys` | No OS-global hotkey registered at startup, and `settings_update` won't re-register one. Settings → Shortcuts explains the absence. |
| `ocr` | `textRecognition` | `begin_region_capture(GrabText)` and `finish_grab_text_capture` refuse; the Grab Text tile is badged "Not installed". |
| `gif` | `gifRecording` | `start_recording` refuses a GIF request before the session starts; the GIF card and its shortcut row are gated. |
| `startup` | `startAtLogin` | Settings → General's startup row is disabled with the reason. |
| `assoc` | `fileAssociations` | Recorded; the app registers no handlers itself today. |
| `cloud` | `cloudSync` | Resolved, nothing consumes it yet. |

Refusals return the `not-installed` error code (`AppError::NotInstalled`),
distinct from `unsupported`: this one is fixable by re-running the installer's
Modify flow, and the UI says so.

**Preferences are seeds, not policy.** On the *first* launch only — no
`settings.json` yet — `start_at_login`, `automatic_updates`, and `help_improve`
seed `settings.general`. Afterwards they are ordinary settings the user owns; a
later launch (or a Repair) never overwrites them. `automaticUpdates` and
`helpImprove` are persisted **intent only** in this build: there is no updater
and no telemetry, so nothing acts on them. They are stored so the wizard's
answer isn't discarded, and so the code that eventually wants to check for
updates or report anything finds a real answer instead of a default it invented.

## The absent case is "everything on"

A missing, unreadable, or newer-schema document resolves to
`Capabilities::unmanaged()` — every feature available, flagged as not coming
from an installer. This is the whole failure model, and it is deliberate:

- A **portable** build has no installer behind it (checked before the disk is
  even touched, so a stray document copied in alongside has no authority).
- A **development run** (`cargo run`, `pnpm tauri:dev`) has none either.
- A **truncated write** or a disk error must not cost a user their features.
- A document from a **newer installer** must not have its unreadable fields
  interpreted as declines — features would vanish after an update.

Reading silence as "the user declined everything" breaks all four. Reading it as
"nothing was declined" only loses the ability to hide features, which is
strictly the safer failure, and the backend still refuses anything genuinely
absent.

## Known gaps

- The `assoc` component and the `fileAssociations` preference are recorded, but
  neither the installer nor the app registers file-type handlers yet, so the
  capability has no enforcement point.
- `cloudSync` has no consumer.
- Conflict detection and Reset-all in Settings → Shortcuts still scan the full
  catalog, including bindings hidden because their component is absent. An
  override left behind for a hidden binding is inert, and keeping it means a
  user who reinstalls the component gets their customization back.
