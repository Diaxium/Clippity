# Elevation, Security, Silent Operation, Exit Codes & Logging

Status: elevation implemented; **CLI + silent operation + stable exit codes
implemented**; security model specified. Covers task Phases 12, 15, 16, 17.

> **Second pass (2026-07-24).** The command-line parser, headless/silent
> execution, and the stable exit-code table below moved from *specified* to
> *implemented*. See
> [08-changelog.md](08-changelog.md#second-pass--2026-07-24).

## Least-privilege elevation (Phase 12)

**Implemented:** the wizard starts **unelevated**. Elevation is requested only
when the plan needs it — an all-users scope, or a destination under a protected
root (`Program Files`, `ProgramData`, `Windows`) — decided by the unit-tested
[`needs_elevation`](../../installer/app/backend/crates/domain/src/install.rs).
When needed, the plan is written to a temp handoff file and the installer
relaunches itself under the `runas` verb with `--resume <file>`
([`services/elevation.rs`](../../installer/app/backend/crates/services/src/elevation.rs),
[`platform/windows/relaunch.rs`](../../installer/app/backend/crates/platform/src/windows/relaunch.rs));
the elevated copy jumps straight to Installing. A per-user install into a
writable folder never prompts. Elevation state is detected via the real token
query in
[`platform/windows/elevation.rs`](../../installer/app/backend/crates/platform/src/windows/elevation.rs).

**Gap (recommended):** today the *whole* elevated copy runs the GUI. The target
architecture is an **unelevated UI + a narrow elevated worker** with a restricted
command schema that validates every path, rejects traversal and reparse-point
(junction) attacks, rejects arbitrary file/registry operations, and restricts to
known Clippity resources with an auditable log. The registry helpers already
scope every write to the fixed `Uninstall\Clippity` / `Run\Clippity` subkeys
(no caller-supplied subkey), which is the first step of that restriction.

**Finding — installer-detection auto-elevation (verify on a real machine).**
In this session the built wizard binary was **refused execution unelevated**
(Windows' UAC *installer-detection* heuristic, triggered by the embedded payload
and the "install/setup" strings in the exe — the same heuristic documented for
the [[installer-uac-exe-naming]] test binaries, but here content-driven and not
fixable by renaming). If the shipping `Clippity Setup.exe` is likewise
auto-elevated, it **defeats the per-user, no-UAC install path** the elevation
design depends on. The fix is to **embed an application manifest** with
`<requestedExecutionLevel level="asInvoker">`, which suppresses installer
detection and lets the wizard control its own elevation via the existing `runas`
relaunch. This was *not* applied blind in this pass because it could not be
runtime-verified here (the same block prevents launching the result) and risks
colliding with any manifest Tauri's bundler embeds during `tauri build`; it is a
priority item for the first real-machine test. See the final report's risks.

## Package & update security (Phase 15)

**Implemented:** the embedded payload is verified against its recorded size and
SHA-256 before a single byte is written to disk
([`payload.rs`](../../installer/app/backend/crates/services/src/payload.rs)); a
mismatch aborts with `SignatureInvalid` before touching the user's disk.

**Specified / not yet in repo:**

- **Authenticode signing** of the Setup exe, the maintenance/uninstaller copy,
  the (future) cleanup worker, and the app — via SignTool, with a timestamp on
  production signatures. Signing credentials must never live in the repo.
- **Signed update metadata** verified before any package executes. The app's
  Tauri updater already carries a minisign pubkey; the wizard must share that
  trust root rather than invent a second one. **Never execute a downloaded
  package merely because its version is newer** — verify identity, signature,
  integrity, architecture, and downgrade policy first.
- **Safe extraction:** path-traversal prevention, reparse-point/junction
  protection, and secure staging-directory permissions for any future
  multi-file/download package.

## Command-line & silent operation (Phase 16) — implemented

The command line is parsed by the pure, unit-tested
[`installer_domain::cli::parse`](../../installer/app/backend/crates/domain/src/cli.rs)
and dispatched in
[`src-tauri/src/lib.rs`](../../installer/app/backend/src-tauri/src/lib.rs):
`--help`/`--version` print and exit; a **silent** mutating command runs headless
via [`app::cli::execute`](../../installer/app/backend/src-tauri/src/app/cli.rs)
and exits with a stable code; everything else (including the ARP-driven
interactive `--uninstall`/`--modify` and the `--resume` elevation handoff) opens
the GUI.

```
ClippityWizard.exe [MODE] [OPTIONS]
MODE:    --install | --modify | --repair | --update | --reinstall | --uninstall
         (no mode → interactive wizard)
OPTIONS: --silent  --passive  --scope user|machine  --install-dir <path>
         --components <a,b,c>  --keep-user-data  --remove-settings
         --log <path>  --no-restart   -h/--help   -v/--version
```

Guarantees enforced by the parser (all unit-tested): unknown flags and
conflicting modes are **rejected** (not ignored); a value flag missing its value
errors; `--silent` with no mode errors (silent mode never opens an unexpected
window); scope aliases (`user`/`current-user`, `machine`/`all-users`) resolve.
A silent install that needs elevation this process lacks returns `UacCancelled`
rather than raising a UAC prompt.

> **Console caveat:** the release binary is built for the Windows GUI subsystem
> (`windows_subsystem = "windows"`), so `--help`/`--version` text and error
> messages are written but not attached to a parent console. Silent operations
> communicate through the **exit code and the log**, which is what unattended
> deployment consumes. Attaching to the parent console for text output is a
> small follow-up.

### Stable exit codes — implemented

[`installer_domain::cli::ExitCode`](../../installer/app/backend/crates/domain/src/cli.rs)
(unit-tested for value + success-classification). Well-known outcomes reuse the
Windows Installer codes deployment tooling already understands; engine-specific
outcomes use a private 200-block so they never collide with a system code.

| Code | Constant | Meaning |
| --- | --- | --- |
| 0 | `Success` | Success |
| 3010 | `SuccessRebootRequired` | Completed; **reboot required** to finish |
| 1602 | `UserCancelled` | User cancelled |
| 1223 | `UacCancelled` | UAC declined / needed but not held |
| 1618 | `AlreadyRunning` | Another maintenance op is running |
| 1639 | `InvalidCommandLine` | Invalid arguments |
| 1603 | `GeneralFailure` | Fatal, uncategorised failure |
| 200 | `AlreadyInstalled` | Install requested but already installed |
| 201 | `SameVersionInstalled` | Same version already installed |
| 202 | `NewerVersionInstalled` | Newer version already installed |
| 203 | `UnsupportedDowngrade` | Refused a downgrade |
| 204 | `InvalidPackage` | Package identity/hash failed |
| 205 | `SignatureFailure` | Signature verification failed |
| 206 | `InsufficientDiskSpace` | Not enough disk space |
| 207 | `FilesInUse` | Files in use, could not replace |
| 208 | `RollbackCompleted` | Failed, rolled back successfully |
| 209 | `RollbackFailed` | Failed, rollback also failed |
| 210 | `PartialCleanup` | Completed; some cleanup deferred |
| 211 | `NotInstalled` | Maintenance requested but nothing installed |

> **Process-exit-code width caveat:** a Windows process exit code is a byte at
> the shell level, so the low byte of the well-known codes (`3010 → 0xBA`,
> `1602 → 0x42`) is what a shell sees, while the log records the precise value.
> A production build that needs the full 16-bit code returned should call
> `ExitProcess` directly with the `i32`.

## Logging & diagnostics (Phase 17)

**Implemented:** `tracing` is initialised
([`infra/logging.rs`](../../installer/app/backend/crates/infra/src/logging.rs))
and every operation logs structured events — scope, versions, resolved paths,
detection result, registry/shortcut actions, reboot-pending, final status. Log
target: `%LOCALAPPDATA%\Clippity\logs\setup.log`.

**Must not be logged** (policy): auth tokens, capture contents, sensitive file
contents, unnecessary personal paths, secrets, signing credentials. The current
logs record only paths and action outcomes, never file contents.

**Follow-up:** a per-operation journal file (distinct from the rolling log) and a
wizard "Export diagnostics" action bundling logs + safe system info.
