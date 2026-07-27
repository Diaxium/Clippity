# ADR — Clippity Windows Installation Architecture

Status: Accepted (2026-07-24)
Supersedes: the implicit "custom wizard is the whole engine" assumption.
Related: [01-current-state-audit.md](01-current-state-audit.md),
[03-installation-model.md](03-installation-model.md).

## Context

Clippity has two Windows delivery mechanisms (see the audit): the app's own
**Tauri MSI + NSIS** bundles, and a **custom Tauri "Clippity Setup" wizard**
that embeds the app and paints its own lifecycle UI. The wizard is a polished
UI with a real payload-copy core and real elevation, but its Windows
integrations are stubbed, its update/maintenance layer is simulated, and it has
no installation state, detection, repair, rollback, or self-removal.

The task requires **one cohesive lifecycle system** (install / detect / modify /
repair / update / reinstall / uninstall / recover / roll back) that shares one
package + component + state model, with a hard rule: *do not hand-roll a
replacement for stable Windows Installer functionality without a documented
reason.*

Versions this decision was made against (from the repo, 2026-07-24):
Tauri **v2**, `windows` crate **0.62.2**, Rust **1.96**, Tauri app bundle
`targets:"all"` (WiX MSI + NSIS), updater plugin present with a minisign pubkey.
Authoritative docs consulted: Microsoft Learn *Uninstall Registry Key
properties*, *Restart Manager*, *MoveFileExW / MOVEFILE_DELAY_UNTIL_REBOOT*,
*SignTool / Authenticode*; Tauri v2 *Windows Installer* and *Updater*; WiX v4/v5
*Bundle (Burn)*. Doc URLs are collected in
[09-references.md](09-references.md).

## Options evaluated

### Option A — Continue with Tauri NSIS as the engine
NSIS can do branded UI, upgrade handling, silent operation, and self-removal,
and Tauri already emits an NSIS setup exe. But its "custom UI" is a scripted
installer look, not the Clippity design system; component/feature-level repair
and transactional rollback are do-it-yourself in NSIS script; and it would mean
**discarding the React wizard** the project has invested in. Rejected as the
*primary* engine because it throws away the brand and still hand-rolls the hard
parts.

### Option B — Tauri MSI (WiX) owns everything
An MSI gives, for free and maintained by Windows Installer itself:
transactional install with automatic rollback, **repair from a cached package**,
**component/feature add-remove (true Modify)**, correct and self-maintained
Add/Remove Programs registration, per-user *and* per-machine modes, and silent
`msiexec` deployment. This is exactly the "stable Windows Installer
functionality" the task says not to reinvent. Its weakness is UI: raw MSI dialog
sets cannot be the Clippity-branded wizard.

### Option C — Branded Tauri wizard as a bootstrapper over an established engine
The Clippity wizard stays as the **UI + bootstrapper**; the transactional work
is delegated to a real engine (WiX **Burn** bundle, or a thin bootstrapper that
drives `msiexec` on a WiX-authored MSI). WiX Burn is *designed* for exactly this:
a bootstrapper application controls detection, planning, apply, repair, modify,
and uninstall of contained packages, with package caching and rollback
boundaries. Keeps the brand; keeps the guarantees.

## Decision

**Adopt Option C as the strategic target, and get there in two stages. In the
near term (this pass), harden the existing custom Rust engine into a *real* one;
in the long term, move the transactional install core onto a WiX-authored MSF
MSI driven by the wizard as a bootstrapper.**

Rationale:

1. **Reuse what is safe and built.** The wizard, its layered crates, the
   payload-embed pipeline, elevation, and the design system all work and are
   maintainable. Ripping them out for a from-scratch WiX Burn bundle now would
   be high-risk with no VM validation available in this environment, and would
   waste the existing investment — which the task explicitly warns against.

2. **Close the dangerous gaps with real Win32, now.** The stubs (ARP registry,
   shortcuts, start-at-login), the missing installation model, the missing
   detection, and the unsafe blunt uninstall are *self-contained* and can be
   made correct with the `windows` crate already in the tree, verified by
   `cargo check`/tests without a VM. These are implemented in this pass
   (see [08-changelog.md](08-changelog.md)).

3. **Record MSI/WiX as the target for the transactional core.** The pieces that
   are genuinely hard and dangerous to hand-roll to production quality —
   transactional rollback across a partially applied install, repair from a
   verified cached package, true component-level modify, and reboot-safe locked-
   file replacement — are where Windows Installer earns its keep. The documented
   reason to *not* fully hand-roll them is this ADR. The near-term engine
   implements a **transaction journal + inverse actions** (a subset of what MSI
   gives) so the behavior is safe today and the concepts map cleanly onto MSI
   custom-action/rollback boundaries later.

4. **One updater, not two.** The app already ships a Tauri updater with a real
   minisign pubkey. The wizard's update flow is retargeted to **coordinate with
   the app's updater** rather than compete: the wizard performs *maintenance*
   updates (full reinstall-over via the bootstrapper for major/scope changes),
   while routine background updates stay with the Tauri updater. The wizard
   never runs a second, divergent auto-update channel. Until the update server
   exists, the wizard's update path is explicitly labelled unavailable rather
   than faked.

## What this means concretely

Near-term (implemented / scaffolded in this pass):
- Real HKCU/HKLM Add/Remove Programs registration, scope-aware, full value set.
- Real desktop + Start-menu shortcuts and Run-key start-at-login (Win32/COM).
- An on-disk **installation manifest** (`install-state.json`) — the single
  authoritative model — written on install, read for detect/modify/uninstall.
- **Detection** correlating manifest + installed exe + registry into an
  `InstallState`.
- **Manifest-driven uninstall** that deletes owned files, preserves unknown
  files, and never blindly `remove_dir_all`s a shared path.
- The wizard copies itself into a maintenance directory as the real
  uninstaller, so the ARP Uninstall button works.
- A **cleanup worker** design + `--cleanup` self-removal path.
- Transaction-journal and inverse-action types (domain), and a locked-file /
  reboot handling design.

Long-term (documented, not built here):
- WiX-authored MSI (`Clippity.msi`) carrying files, components/features,
  shortcuts, registry, per-user/per-machine, and ARP — maintained by Windows
  Installer.
- The wizard becomes a **WiX Burn bootstrapper application** (or a thin
  `msiexec`-driving bootstrapper) so the branded UI drives detect → plan →
  apply → repair → modify → uninstall over the MSI, with rollback boundaries and
  package caching provided by Burn.
- Real signed update packages, verified before execution.

## Migration risks

- **Legacy wizard installs.** Copies installed by the current wizard register a
  plain `…\Uninstall\Clippity` key with no MSI ProductCode. When the MSI target
  lands, it must **detect and adopt** (or cleanly supersede) such installs, or
  a user could end up with both an MSI entry and a stale wizard entry. The
  installation manifest (`installationId`, `schemaVersion`, `scope`) is designed
  to make that adoption deterministic.
- **Per-user vs per-machine.** MSI per-user installs have historically been
  quirky; the wizard's per-user (`%LOCALAPPDATA%\Programs\Clippity`) default
  must be preserved so the no-elevation common case still holds after migration.
- **Two ARP entries during transition.** Until the MSI owns registration, the
  wizard owns it; the cutover must remove the wizard-authored key as part of the
  MSI's upgrade so exactly one entry exists.
- **Updater ownership.** Moving updates behind the bootstrapper must not orphan
  the Tauri updater's minisign trust root; the two must share the same signing
  authority or the app must drop its in-process updater at cutover.

## Consequences

- The wizard stops being a prototype and becomes a real per-user/per-machine
  installer that Windows recognises, this pass, without a VM-gated rewrite.
- The concepts introduced (installation manifest, transaction journal, inverse
  actions, detection states, cleanup worker) are deliberately MSI-shaped, so the
  Option-C target is an evolution rather than a second rewrite.
- The team retains a documented, senior-level reason for every place the code
  does *not* hand-roll Windows Installer behavior: it is staged to inherit it.
