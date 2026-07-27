# Vision and on-device AI roadmap

## Current state and strengths

Clippity downloads/manages ONNX models, performs local object detection and uses
Windows OCR for Grab Text. Model status/progress/update/removal and confidence
settings are implemented. Processing captures locally is a credible product
differentiator.

## Gaps and opportunities

- Download integrity checks expected byte length, not a digest/signature.
- Model choice, size, task, source, license, network use and privacy implications
  are not explained for ordinary users.
- OCR output is saved but not yet used for library full-text retrieval or
  editable text.
- Object detection supports capture but not smart redaction, asset extraction,
  related search or annotation assistance.
- OCR/platform implementations lack macOS/Linux parity and systematic accuracy/
  latency evaluation.

## Delivery portfolio

| Phase | Initiative | Priority | Impact | Complexity | Prerequisites |
| --- | --- | --- | --- | --- | --- |
| V0: trust (0–8 wk) | Cryptographic artifact verification, model cards/licenses/sources, offline mode, clear network/size consent and rollback. | P0 | High | Security/release. |
| V1: useful text (2–4 mo) | Background OCR index, language selection, copy with layout, editable editor text and confidence/error UI. | P1 | High | Library jobs/FTS, accessibility. |
| V2: UI understanding (3–6 mo) | Improve object/UI-element models, keyboard cycling, labels/confidence and deterministic fallback selection. | P1 | High | Native benchmark corpus. |
| V3: privacy/productivity (5–9 mo) | Suggested sensitive-data redaction, asset extraction, auto-tags and related captures—always reviewable and local. | P2 | High | Redaction/export safety. |
| V4: differentiated workflows (6–12 mo) | Change alignment/diff, Live Lens structured output and annotation suggestions. | P3 | Transformative | Capture/editor maturity. |
| V5: platform (6–18 mo) | OS-native/fallback OCR and inference provider matrix for macOS/Linux and hardware acceleration where safe. | P2 | High | Platform abstraction. |

## Implementation phases

Curate consented/non-sensitive evaluation corpora → establish accuracy, latency,
RAM and false-positive baselines → secure artifact supply → build an optional
background job → expose confidence/explanation and deterministic fallback →
cohort test → publish model card and performance/privacy behavior.

## Success criteria

- 100% artifacts cryptographically verified before load; offline mode performs
  no network requests.
- OCR character/word accuracy and object selection hit-rate meet published
  per-language/task thresholds; p95 latency budgets are met on reference
  hardware.
- Suggested redactions have user review, reversible editing and export-time
  verification; false positives never silently destroy content.
- Model-disabled users retain complete rectangle/window capture and metadata
  search workflows.
- Every model has version, source, license, size, task, limitations and removal
  information visible in-app.

## Risks and alternatives

- Model output can be confidently wrong; treat it as suggestions with visible
  fallback, not authority.
- Larger/more models increase installer/network/RAM costs; task-specific optional
  downloads and OS-native APIs may outperform one universal model.
- Training/evaluation data can create licensing/privacy risk; document provenance
  and prefer permissive, auditable sources.

