# Installer Test Matrix & Release Evidence

Current for Clippity 0.3.2 (2026-09-09). The installer is verified at three
levels: pure policy tests, filesystem/transaction service tests, and a packaged
Windows lifecycle smoke test performed before publishing.

## Automated suites

| Suite              | Coverage                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App frontend       | Settings persistence and UI behavior across the application                                                                                                             |
| App Rust workspace | Provisioning, installed-file routing, settings, capture, encoding, storage, and platform behavior                                                                       |
| Installer domain   | CLI, install planning, semantic-version/channel policy, detection, repair, removal selection, progress, recovery, and rollback decisions                                |
| Installer services | GitHub release selection, required SHA-256 digest and size validation, journalled install/update, repair, safe data removal, settings export, and unsafe-root rejection |
| Static checks      | Both TypeScript workspaces, both Rust workspaces, rustfmt, clippy with warnings denied, ESLint, and dependency audit                                                    |

Canonical commands:

```powershell
pnpm check
pnpm test:js
pnpm lint
cargo test --manifest-path app/backend/Cargo.toml --workspace
cargo clippy --manifest-path app/backend/Cargo.toml --workspace --all-targets -- -D warnings

Push-Location installer
pnpm check
cargo test --manifest-path app/backend/Cargo.toml --workspace
cargo clippy --manifest-path app/backend/Cargo.toml --workspace --all-targets -- -D warnings
Pop-Location
```

## Lifecycle matrix

| Workflow         | Required verification                                                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh install    | Custom per-user destination, payload hash, manifest and installation identity, ARP entry, shortcuts, selected capabilities, file associations, and seeded app preferences                      |
| Update           | Older packaged Setup followed by 0.3.2 bundled-update handoff; identity, destination, scope, components, preferences, and user data retained; executable replaced with final build             |
| Modify           | Component selection changes without moving the install or reverting preferences changed inside the app                                                                                         |
| Repair           | Missing/corrupt owned executable restored from the embedded payload; manifest, associations, shortcuts, settings, and captures preserved                                                       |
| Uninstall        | App/integrations always removed; cache, settings, and content independently honored; export created before settings removal; unknown files retained; unsafe recursive roots rejected           |
| Automatic update | Managed app honors `automaticUpdates`; maintenance check is daily-throttled, channel-aware, digest/size verified, waits for the app, applies transactionally, and relaunches unless suppressed |

## Production artifact gate

Before publishing a release:

1. Confirm `main`, `origin/main`, the tag target, and the build commit are the
   same commit with a clean tracked working tree.
2. Run the full production build and stage only
   `Clippity-<version>-Setup.exe`, `Clippity-<version>-portable.zip`, and
   `SHA256SUMS.txt`.
3. Run the fresh/update/modify/repair/uninstall packaged lifecycle smoke test
   in an isolated data root and remove all temporary integrations afterward.
4. Recompute both SHA-256 values locally and compare them byte-for-byte with
   `SHA256SUMS.txt`.
5. Upload, download the published assets again, recompute their hashes, and
   verify the GitHub asset digests and sizes before declaring the release
   complete.

Unsigned binaries remain an explicit release-note limitation. Update packages
are accepted only when GitHub supplies the expected `sha256:` asset digest and
the downloaded byte count and digest both match.
