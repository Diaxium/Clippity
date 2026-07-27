# Sharing and export roadmap

## Current state and strengths

Clippity can copy output, export flattened/editor scenes and hand saved captures
to the OS by open, reveal or copy-path. The backend intentionally does not
upload anything, which is a strong privacy baseline. Export encoding is carried
by the data URI and the backend writes bytes faithfully.

## Gaps and opportunities

- “Share destination” currently means local OS handoff, not sharing; labels and
  expectations should be clearer.
- Format, scale, metadata, compression, naming and destination controls are
  fragmented.
- No batch export, share history, expiry/revoke, credential store, destination
  permissions or offline retry exists.
- No portable editable package or narrative Markdown/HTML/PDF output.

## Delivery portfolio

| Phase | Initiative | Priority | Impact | Complexity | Prerequisites |
| --- | --- | --- | --- | --- | --- |
| X0: clarify (0–8 wk) | Rename local actions; unify export sheet; PNG/JPEG/WebP, scale/quality, metadata strip, naming preview, destination and post-action. | P0/P1 | High | UI/result contract. |
| X1: batch/portable (2–4 mo) | Batch export, ZIP/portable editable package, clipboard formats, Markdown embed and drag-out. | P1 | High | Job service, scene assets. |
| X2: OS/apps (3–6 mo) | Windows share sheet and opt-in destination adapters with credential isolation, scopes, retry and audit history. | P2 | High | Security/integration host. |
| X3: links/team (6–12 mo) | Optional encrypted upload/share links with expiry, password, revoke and no-account local core. | P3 | High | Service/privacy/legal ops. |
| X4: narrative (6–12 mo) | Multi-step Markdown/HTML/PDF/GIF exports with templates and accessible output. | P2 | Transformative | Narrative editor/templates. |

## Implementation phases

Canonical export request/result → local format matrix → accessible preview and
size estimate → background/batch jobs → security threat model/credential store →
one adapter beta → history/retry/revoke → optional hosted service. Every network
destination must be explicit per recipe/run and visible in Privacy Center.

## Success criteria

- Export success ≥99.5%; format/size preview within 10% of result; batch jobs are
  cancelable and resumable where safe.
- Users choose and complete common export in ≤2 actions from result/editor.
- Metadata stripping is verified; irreversible redaction never exports original
  sensitive pixels in the flattened result.
- Network destinations have zero silent uploads, scoped credentials, clear retry
  state and revocation/retention guarantees.

## Risks and alternatives

- Destination APIs create maintenance/security burden; prefer OS share sheet and
  a sandboxed adapter contract before many first-party integrations.
- Hosted links change the product's privacy/operations obligations; validate
  with encrypted packages and bring-your-own destination first.
- PDF output is document layout, not merely image encoding; share narrative
  components with the documentation export pipeline.

