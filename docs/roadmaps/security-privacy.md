# Security and privacy roadmap

## Current state

Clippity is local-first, does not upload captures, validates many library/editor
paths and uses HTTPS for model sources. Production npm dependencies report no
known vulnerabilities as of the audit. However, the Tauri CSP is `null`, all
six windows share one capability with broad opener/dialog defaults, custom
commands are not visibly separated by window, the updater config is not backed
by an updater runtime/release process, and model integrity uses expected length
rather than a cryptographic digest. A library path guard compares string
prefixes, which is weaker than component-aware containment, especially on
Windows.

## Strengths to preserve

- No mandatory account/cloud path; sharing is explicit.
- Closed enums and domain validation for most IPC payloads.
- Partial downloads use `.part` and only rename after size validation.
- Capture provenance and data locations are inspectable files.
- Errors are typed rather than leaking raw backend failures by default.

## Problems, gaps and missed opportunities

- Missing CSP and least-privilege per-window capabilities increase the impact of
  any frontend injection.
- `validate_id` should use normalized path components/canonical parents, not a
  lossy string `starts_with`; share commands should only act on validated
  artifacts or explicit user-selected paths.
- Model/update artifacts need signed/digest verification and rollback.
- Sensitive captures, thumbnails, trash, scene-embedded images and logs are not
  governed by retention/encryption/exclusion controls.
- No SECURITY policy, threat model, dependency/SBOM pipeline, disclosure path or
  incident/update channel exists.

## Initiatives

| ID | Class | Recommendation | Priority | Impact | Complexity | Dependencies |
| --- | --- | --- | --- | --- | --- | --- |
| SEC1 | Foundation | Add a restrictive CSP; remove inline/eval needs; test every window in dev and production. | P0 | High | M | Frontend asset audit. |
| SEC2 | Foundation | Split Tauri capabilities by window and grant only necessary plugin/window operations; document custom-command authorization. | P0 | High | L | Window/command inventory. |
| SEC3 | Foundation | Replace string-prefix path checks with Windows-aware component containment, symlink/reparse-point policy and explicit artifact scopes; harden share/open/import. | P0 | High | M | Path security tests. |
| SEC4 | Foundation | Verify SHA-256/signatures for models and signed application updates; pin trusted release metadata and support rollback. | P0 | High | L | Release/updater pipeline. |
| SEC5 | Foundation | Automated npm/Rust advisory scan, SBOM, license policy, secret scan, binary signing and provenance attestations in CI. | P0 | High | M | CI/release credentials. |
| SEC6 | Major | Privacy Center: local/network activity, model sources, data/cache locations, clear/export, retention, sensitive-app/window exclusions and telemetry opt-in. | P1 | High | L | Settings/screens/docs. |
| SEC7 | Major | Ephemeral capture mode and optional encrypted vault/workspace with key recovery design. | P2 | High | XL | Data architecture/threat model. |
| SEC8 | Major | Redaction safety: irreversible export redaction, metadata stripping and warnings when editable originals still contain sensitive pixels. | P1 | High | L | Editor/export pipeline. |
| SEC9 | Experiment | Sandboxed integrations/extensions with declarative destination scopes, credential isolation and per-run consent. | P3 | High | XL | Extension architecture. |

## Milestones and implementation phases

- **Short term:** threat model, SEC1–SEC5, publish SECURITY.md, remove misleading
  update configuration until end-to-end updates are verified, and add security
  regression tests.
- **Mid term:** SEC6 and SEC8, backup/privacy controls, security review of
  recording/recipes/search.
- **Long term:** encrypted vault and sandboxed integrations after independent
  design review.

For each boundary: enumerate assets/attackers → minimize permission → validate at
the backend → log non-sensitive security events → fuzz/fault test → review →
document user-visible behavior.

## Success criteria

- CSP blocks unapproved script/network sources in every production window.
- Each window has a reviewed minimal capability; utility windows cannot invoke
  unrelated file/dialog/open operations.
- Path traversal, sibling-prefix, case, UNC, symlink/reparse and race tests pass.
- 100% downloaded executable/model/update artifacts are digest/signature
  verified before activation; update rollback is tested.
- Critical advisories block release; SBOM and signed provenance ship with every
  release; disclosure SLA is published.
- Users can find, export and clear all Clippity-held data in ≤2 minutes.

## Risks, tradeoffs and alternatives

- CSP/capability tightening can break hidden cross-window assumptions; stage in
  report/test mode and maintain an explicit matrix.
- Encryption can create unrecoverable loss; make it optional and design key
  backup before marketing it.
- Secure deletion is unreliable on SSD/cloud-synced folders; explain guarantees
  honestly and prioritize encryption/retention.
- This roadmap is a code/config assessment, not a penetration test; obtain an
  independent review before public distribution or sync/integrations.

