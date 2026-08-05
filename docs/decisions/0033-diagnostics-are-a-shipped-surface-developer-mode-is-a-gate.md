# 0033 — Diagnostics are a shipped surface; developer mode is a gate over it

- **Status:** Accepted (implemented)
- **Date:** 2026-08-04
- **Area:** `app/backend/crates/domain/src/developer.rs`,
  `app/backend/crates/domain/src/settings.rs` (the `developer` section),
  `app/backend/crates/infra/src/{logging.rs,runtime.rs}`,
  `app/backend/crates/platform/src/windows/os_info.rs`,
  `app/backend/crates/services/src/diagnostics_service.rs`,
  `app/backend/src-tauri/src/app/commands.rs` (`developer_*`),
  `app/shared/src/contracts/developer.ts`,
  `app/frontend/src/features/developer/`,
  `app/frontend/src/shared/lib/{ipcMetrics.ts,featureFlags.ts,logger.ts}`
- **Relates to:**
  [developer-experience roadmap](../roadmaps/developer-experience.md) **DX6**
  (structured diagnostics console / support bundle with redaction),
  [security-privacy roadmap](../roadmaps/security-privacy.md) (what a bundle
  may carry),
  [0031 — recording is Media Foundation](0031-recording-is-media-foundation-one-session-two-outputs.md)
  (whose session counters the recording card reports)

## Context

Settings → Advanced was a `ComingSoonPanel`. Everything a support conversation
needs — which Windows, which WebView, where the captures went, whether the
global hotkey actually registered, why a recording dropped a third of its
frames — was either in a `tracing` line nobody could reach or nowhere at all.
`logging::init` wrote to stdout, which a windowed release build does not have.

Three questions had to be answered before writing any of it.

**Who is this for?** The obvious answer — "developers" — is wrong for most of
it. A user reporting a bug is the person who needs the log file to exist, and
they will never turn on a developer switch to get one.

**What may leave the machine?** Everything here is local until someone attaches
it to an email. The one action that produces a shareable artefact is the
bundle, and capture file names are the most identifying strings the app writes:
the default template is `{label} - {date} {time}`, so a name routinely contains
the title of whatever window was open.

**What does a switch that nothing reads cost?** A feature-flag table is the
easiest thing here to fill with plausible entries. Every one that gates nothing
is a claim the settings page makes on the app's behalf and cannot keep.

## Decision

**Logging is machinery and ships on for everyone; developer mode gates only
presentation.** `developer.logToDisk` defaults on, writing size-capped rotating
files under `<data>/logs` (8 MiB × 5 by default). The log viewer, the system
information card, and the bundle export are available without arming anything.
Developer mode gates the WebView inspector, live instrumentation, feature
flags, cache clearing, and safe mode — the parts that are destructive or that
record command metadata.

**Developer mode disarms itself.** `DeveloperExpiry` defaults to `restart`,
evaluated once in `SettingsService::load` against a fresh process, which is
what makes the policy mean what it says. `day` measures from an `enabledAtMs`
stamped by the service, not by the webview.

**The bundle is a redacted folder, not an archive.** Redaction (account name,
home directory, capture file names) is on by default and implemented as pure
rules in `domain::developer::Redaction` so the edge cases — a two-letter
account name that appears inside ordinary words, a capture name containing
spaces, mixed-case Windows paths — are unit-tested without touching a disk. A
folder rather than a zip because it needs no compression dependency, the user
can look inside before sending it, and Explorer turns it into a zip in one
click.

**Instrumentation sits at the boundary every call already crosses.** IPC
timing is recorded in `services/tauri/client`'s `invoke`, so it observes every
command rather than the ones a feature remembered to instrument, and it is a
no-op until `commandTiming` arms it. The frontend logger forwards into the same
`tracing` file, so both halves of a bug share one timeline — with the `ipc`
module excluded, because a record about an unreachable backend must not be
routed through the unreachable backend.

**Feature flags list only switches something reads.** Two, today:
`capture.hdr` and `recorder.duplication`, each a process-global kill switch in
the platform crate on a path that already has a tested fallback. The frontend
registry and `services::settings_service`'s constants must agree by name.

**Safe mode is a marker file, consumed by the launch that honours it.**
`AppHandle::restart` re-executes with this process's arguments, so there is
nothing to attach a flag to; `infra::runtime` writes `<data>/safe-mode`, and
boot deletes it as it reads it — which is what stops safe mode from becoming
sticky after a crash that happened to occur while it was armed.

## Consequences

- A bug report from a user who has never opened Settings → Advanced still has a
  session behind it, and the bundle that carries it is redacted by default.
- The backend log level is a setting rather than an environment variable —
  except when `CLIPPITY_LOG` / `RUST_LOG` is set, which wins outright and which
  the page says is winning, rather than showing a control that silently does
  nothing.
- `tauri/devtools` is a default feature of the app crate, so the inspector
  works in a release build. `--no-default-features` removes it, and the command
  refuses with `unsupported` rather than lying about having opened something.
- Adding a flag now means adding a consumer. That is the intended friction.
- The diagnostics surface is read-fresh on every open; nothing here is cached,
  because a diagnostics page showing a stale truth is worse than none.

## Alternatives

**A separate diagnostics window.** More room, and every user who needs it is
already in Settings looking for it. Rejected as a second surface to maintain
for the same content.

**Time-based log rotation (`tracing-appender`).** A session is the unit of
diagnosis, not a day: a user reporting a bug after a week of uptime would have
their evidence split across seven files while a user who restarts hourly would
have one line in each. Size-based rotation also gives the retention cap the
settings page exposes.

**A `reload::Handle` for the log filter.** The runtime level is one number read
per callsite; an `AtomicU8` behind a `filter_fn` does it without the handle's
type gymnastics, and leaves `EnvFilter` free to own the environment-pinned case
outright.

**Emitting log lines as events for the viewer.** Watching the log would then
generate log traffic, and the failure being investigated is frequently "the app
is busy". The viewer polls a bounded tail instead.
