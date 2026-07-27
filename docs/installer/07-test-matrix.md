# Test Matrix & Evidence

Covers task Phase 19. Two parts: the automated tests that run today, and the
manual Windows matrix to run on disposable VMs / Windows Sandbox before shipping.

## Automated tests (run this pass)

All green on 2026-07-24. Run with the rename workaround for the UAC-blocked
`installer_*` binaries (see [installer-uac-exe-naming] / the installer README).

| Suite | Count | Notable coverage |
| --- | --- | --- |
| `installer-domain` | 23 | plan building & sizing; elevation policy incl. protected-root casing/separator/prefix-sibling edge cases; version compare; removal summary; **detection `assess` state machine** (not-installed / legacy / partial / damaged / older / same / newer / schema-too-new); progress snapshot ordering; flow shapes |
| `installer-services` | 7 | resume-arg parsing; **UTC clock civil-date conversion**; **uninstall preserves unknown files**; **empty install dir removed after owned files** |

```bash
# from installer/app/backend
cargo test --no-run -p installer-domain -p installer-services
# copy each installer_* test exe to a name without install/setup, then run it
```

`cargo check --workspace` and `pnpm check` (tsc for shared + frontend, cargo for
backend) both pass.

The two uninstall-safety tests are the most important: they encode the guarantee
that a Clippity installed into a shared folder cannot delete unrelated files.

## Manual Windows matrix (pre-ship, disposable VMs / Sandbox)

Test both clean and previously-used environments. Legend: **[R]**eady to test
against the implemented engine · **[P]**ending an unimplemented feature.

### Installation
- [R] Clean per-user install · [R] clean per-machine (elevated) · [R] custom dir
- [R] Path with spaces · [R] non-ASCII username · [P] low disk space (no check yet)
- [R] UAC denied (stays on Review) · [R] cancelled · [R] installer force-closed
  (detection reports `partial` next launch)
- [R] Same version already installed (detection `same-version`) · [R] newer
  installed (`newer-version`, downgrade refused) · [R] older (`older-version`)
- [R] Legacy MSI/NSIS present → detection `legacy-unmanaged`

### Modify
- [P] Add/remove one optional component (needs decomposed payload) ·
  [R] cancel/crash during modify (manifest not overwritten until commit)

### Repair
- [R] Detection flags `damaged` when exe missing · [P] per-file corruption
  restore from `sha256` · [R] user settings/captures preserved (never touched)

### Update
- [P] Normal update / with app open / locked files / corrupt download / invalid
  signature / network interruption / cancel / failed migration / rollback /
  reboot-required — **update apply is still simulated; coordinate with the app's
  Tauri updater first (ADR).**

### Reinstall
- [R] Reinstall-over-running (exe rename-away) · [P] preserve/reset/clean
  variants · [R] reinstall after partially failed uninstall (detection routes)

### Uninstall — verify after each, by inspection
- [R] Normal · [R] while app running (locked exe → reboot-scheduled) ·
  [R] unknown files in app dir **preserved** · [R] preserve/remove settings ·
  [R] preserve captures (default) · [R] explicit full data removal (gated)
- [R] ARP entry removed · [R] shortcuts removed (recorded paths) · [R] Run value
  removed · [P] services/protocols/tasks (none created, nothing to remove) ·
  [R] maintenance exe self-removal (reboot fallback) · [P] temp cleanup-worker
  removal (worker not built)

### Recovery
- [R] Kill during staging/apply → next launch detects `partial`/`damaged` ·
  [P] automatic resume of a specific interrupted op (needs journal) ·
  [R] re-run after incomplete op is safe (idempotent reversals)

### Post-uninstall inspection checklist
Program Files · ProgramData · LocalAppData · Roaming AppData · Start Menu ·
Desktop · `HK{CU,LM}\…\Uninstall\Clippity` · `…\Run\Clippity` · Services · Task
Scheduler · Startup · Firewall · Env vars · running processes · Settings ›
Installed apps. **Do not declare uninstall successful from the wizard's success
page alone.**
