//! Developer + diagnostics domain — the wire shapes Settings →
//! Advanced renders, plus the **redaction rules** an exported bundle is
//! run through. Pure: no filesystem, no Tauri, no clock.
//!
//! The redaction half is the reason this is a domain module rather than
//! a bag of structs in the service. A bundle exists to be sent to
//! somebody else, so "what counts as identifying" is a rule with edge
//! cases (a user name that is also a common word, a path already
//! written with an environment variable, a capture named after the
//! window it came from) — exactly the kind of thing that should be
//! unit-tested without touching a disk.

use serde::{Deserialize, Serialize};

/// Placeholder a redacted home directory collapses to. The literal
/// Windows environment variable, so a reader can still tell *what* the
/// path was relative to.
pub const HOME_PLACEHOLDER: &str = "%USERPROFILE%";

/// Placeholder a redacted account name collapses to.
pub const USER_PLACEHOLDER: &str = "<user>";

/// Placeholder a redacted capture file name collapses to. The extension
/// survives, because "the failing file was a .mp4" is diagnosis and the
/// name almost never is.
pub const CAPTURE_PLACEHOLDER: &str = "<capture>";

/// What an exported diagnostics bundle may contain.
///
/// Every field defaults to the private answer: a bundle that has not
/// been configured is the redacted one. The three "include" fields are
/// deliberately *opt-in* — logs can quote window titles, and captures
/// are the user's screen.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BundleOptions {
    /// Replace the account name and home directory in every included
    /// file. Ships on.
    #[serde(default = "yes")]
    pub redact_paths: bool,
    /// Replace capture file names with [`CAPTURE_PLACEHOLDER`]. Ships
    /// on: a capture is routinely named after the window it came from,
    /// which is the most identifying string the app produces.
    #[serde(default = "yes")]
    pub redact_capture_names: bool,
    /// Copy the retained log files into the bundle. Ships on — without
    /// them a bundle is a settings dump.
    #[serde(default = "yes")]
    pub include_logs: bool,
    /// Include the persisted settings.json (itself redacted).
    #[serde(default = "yes")]
    pub include_settings: bool,
}

fn yes() -> bool {
    true
}

impl Default for BundleOptions {
    fn default() -> Self {
        Self {
            redact_paths: true,
            redact_capture_names: true,
            include_logs: true,
            include_settings: true,
        }
    }
}

/// Where an exported bundle landed, and what went into it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BundleResult {
    /// Absolute path of the bundle folder.
    pub path: String,
    /// Names of the files written inside it, in write order.
    pub files: Vec<String>,
    pub bytes: u64,
    /// True when the contents went through [`Redaction`].
    pub redacted: bool,
}

/// One monitor as the capture pipeline sees it — the numbers that
/// explain a mis-cropped multi-monitor or mixed-DPI capture.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorDiagnostics {
    pub id: u32,
    pub name: String,
    /// Physical position on the virtual desktop. Negative on a monitor
    /// left of / above the primary, which is the case that breaks
    /// naive capture math.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// DPI scale as a factor (1.5 = 150 %).
    pub scale: f32,
    pub refresh_hz: f32,
    pub primary: bool,
    /// Whether Windows reports this output presenting in HDR.
    pub hdr: bool,
    /// SDR white level in nits when known — what the HDR tone-map is
    /// anchored to.
    pub sdr_white_nits: Option<f32>,
}

/// The app's own directories, as resolved for this process.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticPaths {
    pub data: String,
    pub cache: String,
    pub captures: String,
    pub models: String,
    pub logs: String,
    pub executable: String,
    pub settings_file: String,
}

/// Everything the "Copy system information" action puts on the
/// clipboard, and the first file in an exported bundle.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub app_version: String,
    /// `debug` or `release` — which half of the code base is running.
    pub build_profile: String,
    /// True when this process was started by "Restart in safe mode".
    pub safe_mode: bool,
    /// True when running from a portable folder rather than an install.
    pub portable: bool,
    pub os: String,
    /// Human OS version, e.g. `Windows 11 Pro 26100`.
    pub os_version: String,
    pub arch: String,
    /// WebView2 runtime version, when it can be queried.
    pub webview_version: Option<String>,
    pub cpu_count: u32,
    pub paths: DiagnosticPaths,
    pub monitors: Vec<MonitorDiagnostics>,
    /// Registry ids of the models currently installed on disk.
    pub installed_models: Vec<String>,
    /// Live log file, when disk logging is on.
    pub log_file: Option<String>,
    /// Total bytes across every retained log file.
    pub log_bytes: u64,
    /// Milliseconds since this process started.
    pub uptime_ms: u64,
}

/// State of one registered global accelerator.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutDiagnostics {
    /// What the setting asked for, in `Mod+Shift+Key` notation.
    pub combo: String,
    /// Whether the OS accepted the registration.
    pub registered: bool,
    /// Why not, when it didn't (unparseable, reserved, taken).
    pub detail: Option<String>,
}

/// One window the app owns, and whether it is currently on screen.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowDiagnostics {
    pub label: String,
    pub visible: bool,
    pub focused: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Live runtime state — the answer to "why is nothing happening?".
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub windows: Vec<WindowDiagnostics>,
    pub capture_shielded: bool,
    pub global_capture: ShortcutDiagnostics,
    /// Whether the installer's capture integration is present — the
    /// thing that decides whether a global hotkey is registered at all.
    pub global_hotkeys_installed: bool,
    /// Library index database, and how big it is.
    pub library_db: String,
    pub library_db_bytes: u64,
    /// Bytes under the cache directory (thumbnails, sidecars, staging).
    pub cache_bytes: u64,
    pub monitors: Vec<MonitorDiagnostics>,
}

/// What the last recording session actually did — the counterpart to
/// the live `RecorderStatus`, kept after the session ends so a user can
/// look at why a clip came out wrong.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecorderDiagnostics {
    /// `mp4` or `gif`.
    pub format: String,
    pub width: u32,
    pub height: u32,
    /// Frame rate the session was configured to encode at.
    pub target_fps: u32,
    /// Frames the encoder actually committed.
    pub frames: u64,
    /// Frames the capture source produced that the encoder refused.
    pub dropped: u64,
    pub duration_ms: u64,
    pub bytes: u64,
    pub had_audio: bool,
    /// Whether the session asked for a hardware encoder. Whether it got
    /// one is Media Foundation's decision and is logged, not returned.
    pub preferred_hardware: bool,
    /// How the session ended: `committed` / `discarded` / `failed`.
    pub outcome: String,
}

impl RecorderDiagnostics {
    /// Dropped frames as a percentage of everything the source
    /// produced. The number a user actually reads — 3 000 dropped
    /// frames means nothing without the total.
    pub fn drop_rate_pct(&self) -> f32 {
        let produced = self.frames + self.dropped;
        if produced == 0 {
            return 0.0;
        }
        (self.dropped as f32 / produced as f32) * 100.0
    }

    /// Average bitrate in kbit/s over the session, or `None` for a
    /// session with no duration (a discard, a failure before the first
    /// frame) where the number would be a division by zero dressed up
    /// as data.
    pub fn avg_bitrate_kbps(&self) -> Option<u64> {
        if self.duration_ms == 0 || self.bytes == 0 {
            return None;
        }
        Some((self.bytes * 8 * 1_000) / (self.duration_ms * 1_000))
    }
}

/// A cache a developer may clear. Each maps to exactly one directory or
/// file set in the service — the enum exists so the command surface
/// can't be handed an arbitrary path to delete.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CacheTarget {
    /// Library thumbnails. Rebuilt on demand.
    Thumbnails,
    /// The WebView2 user-data directory. Takes effect after a restart.
    Webview,
    /// Downloaded model files.
    Models,
    /// Scratch files from exports and staging.
    Temp,
    /// Every rotated log file (the live one is truncated).
    Logs,
}

impl CacheTarget {
    /// Human label — the confirmation dialog says exactly what goes.
    pub fn label(self) -> &'static str {
        match self {
            CacheTarget::Thumbnails => "thumbnail cache",
            CacheTarget::Webview => "WebView cache",
            CacheTarget::Models => "downloaded models",
            CacheTarget::Temp => "temporary files",
            CacheTarget::Logs => "log files",
        }
    }

    /// Whether clearing this only takes effect after a restart.
    pub fn needs_restart(self) -> bool {
        matches!(self, CacheTarget::Webview)
    }
}

/// A folder the developer page can open in the OS file manager.
///
/// An enum, like [`CacheTarget`], so "open a folder" can never become
/// "open whatever path the webview asked for" — the command surface is
/// reachable from any window, and a path parameter would make it a
/// general-purpose shell-open.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FolderTarget {
    /// `<root>/data` — settings, the library index, captures.
    Data,
    /// `<data>/logs` — the rotating log files.
    Logs,
    /// The active captures directory, user override included.
    Captures,
    /// `<root>/cache`.
    Cache,
    /// `<root>/models`.
    Models,
    /// `<data>/diagnostics` — where exported bundles land.
    Bundles,
    /// The directory holding the running executable.
    Install,
}

impl FolderTarget {
    /// Human label, for the button and for the log line.
    pub fn label(self) -> &'static str {
        match self {
            FolderTarget::Data => "application data",
            FolderTarget::Logs => "logs",
            FolderTarget::Captures => "captures",
            FolderTarget::Cache => "cache",
            FolderTarget::Models => "models",
            FolderTarget::Bundles => "diagnostics bundles",
            FolderTarget::Install => "installation",
        }
    }
}

/// One line of the log file, as the viewer renders it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// Monotonic index within the returned window, so the viewer has a
    /// stable React key without hashing the text.
    pub seq: u64,
    /// ISO-ish timestamp as written, or empty for a continuation line.
    pub timestamp: String,
    /// Lower-case level (`error`/`warn`/`info`/`debug`/`trace`), or
    /// empty when the line carries no level — a panic's backtrace, say.
    pub level: String,
    pub message: String,
}

/// Pure: split one formatted log line into its parts.
///
/// The subscriber writes `<rfc3339> <LEVEL> <target>: message…`, where
/// the level is padded to five columns — so a four-letter level has two
/// spaces before it and `ERROR` has one. Splitting on runs of
/// whitespace rather than on a fixed separator is what makes both
/// spellings parse.
///
/// A line that doesn't match (a panic backtrace, a wrapped multi-line
/// field) comes back with empty timestamp/level and the whole line as
/// its message: dropping it would hide exactly the lines a crash
/// produces.
pub fn parse_log_line(seq: u64, line: &str) -> LogLine {
    let trimmed = line.trim_end();
    let mut cursor = trimmed.trim_start();
    let (timestamp, rest) = split_token(cursor);
    if looks_like_timestamp(timestamp) {
        cursor = rest.trim_start();
        let (level, rest) = split_token(cursor);
        if is_level(level) {
            return LogLine {
                seq,
                timestamp: timestamp.to_string(),
                level: level.to_ascii_lowercase(),
                message: rest.trim_start().to_string(),
            };
        }
    }
    LogLine {
        seq,
        timestamp: String::new(),
        level: String::new(),
        message: trimmed.to_string(),
    }
}

/// The first whitespace-delimited token of `s`, and everything after it.
fn split_token(s: &str) -> (&str, &str) {
    match s.find(char::is_whitespace) {
        Some(i) => (&s[..i], &s[i..]),
        None => (s, ""),
    }
}

fn looks_like_timestamp(s: &str) -> bool {
    // `2026-08-04T12:34:56.789012Z` — cheap shape check, not a parse.
    s.len() >= 20 && s.starts_with(|c: char| c.is_ascii_digit()) && s.contains('T')
}

fn is_level(s: &str) -> bool {
    matches!(
        s.to_ascii_uppercase().as_str(),
        "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE"
    )
}

/// The redaction rules an exported bundle is run through.
///
/// Constructed from [`BundleOptions`] plus the account name the process
/// is running as. Holding the account name (rather than deriving it per
/// call) is what lets the rules collapse `C:\Users\ada\…` *and* a bare
/// `ada` in a log message with one pass.
#[derive(Clone, Debug)]
pub struct Redaction {
    paths: bool,
    capture_names: bool,
    /// The account name, lower-cased. Empty disables name matching —
    /// which is the right behaviour for a one- or two-character name,
    /// where substring replacement would corrupt ordinary words.
    user: String,
    /// The user's home directory, lower-cased, or empty.
    home: String,
}

/// Account names shorter than this are not substituted on their own: a
/// two-letter name appears inside ordinary words often enough that
/// replacing it would mangle the log rather than redact it. The home
/// directory is still collapsed, which is where the name actually leaks.
const MIN_REDACTABLE_NAME: usize = 3;

impl Redaction {
    /// Build the rules. `user` is the account name and `home` its
    /// profile directory; either may be empty when unknown.
    pub fn new(options: &BundleOptions, user: &str, home: &str) -> Self {
        let user = user.trim().to_ascii_lowercase();
        Self {
            paths: options.redact_paths,
            capture_names: options.redact_capture_names,
            user: if user.len() >= MIN_REDACTABLE_NAME {
                user
            } else {
                String::new()
            },
            home: home.trim().to_ascii_lowercase(),
        }
    }

    /// Rules that change nothing — what an unredacted export uses, so
    /// the write path has no branch of its own.
    pub fn none() -> Self {
        Self {
            paths: false,
            capture_names: false,
            user: String::new(),
            home: String::new(),
        }
    }

    /// True when these rules would change something. Drives the
    /// `redacted` flag on [`BundleResult`].
    pub fn is_active(&self) -> bool {
        self.paths || self.capture_names
    }

    /// Apply every enabled rule to one line of text.
    ///
    /// Case-insensitive: Windows paths arrive from a dozen APIs with
    /// inconsistent casing, and a redaction that only catches one of
    /// them is not a redaction.
    pub fn apply(&self, text: &str) -> String {
        let mut out = text.to_string();
        if self.paths {
            if !self.home.is_empty() {
                out = replace_case_insensitive(&out, &self.home, HOME_PLACEHOLDER);
            }
            if !self.user.is_empty() {
                out = replace_case_insensitive(&out, &self.user, USER_PLACEHOLDER);
            }
        }
        if self.capture_names {
            out = redact_capture_names(&out);
        }
        out
    }
}

/// Extensions whose file names are treated as capture content. A
/// capture is routinely named after the window it came from, which
/// makes the name the most identifying string the app writes.
const CAPTURE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "gif", "mp4"];

/// Pure: replace `<name>.<capture-ext>` with `<capture>.<ext>`.
///
/// Deliberately leaves the extension: "the file that failed was a .mp4"
/// is diagnosis, while its name almost never is.
///
/// The interesting case is that capture names contain spaces — the
/// default template is `{label} - {date} {time}`, so a real name reads
/// `Gmail - Inbox 2026-08-04.png`. Tokenising on whitespace would leave
/// the window title (the identifying half) behind, so the scan walks
/// **backwards** from the extension to the nearest path separator or
/// quote, and only falls back to a whitespace boundary when the name
/// isn't part of a path.
pub fn redact_capture_names(text: &str) -> String {
    text.split_inclusive('\n')
        .map(redact_capture_names_in_line)
        .collect()
}

/// Characters that always end a file name to the left of it.
fn is_name_boundary(ch: char) -> bool {
    matches!(
        ch,
        '/' | '\\' | '"' | '\'' | '(' | ')' | '[' | ']' | ',' | ';' | '=' | '\n'
    )
}

fn redact_capture_names_in_line(line: &str) -> String {
    let bytes = line.as_bytes();
    let lower = line.to_ascii_lowercase();
    let mut out = String::with_capacity(line.len());
    // Everything before this index has already been copied to `out`.
    let mut copied = 0usize;
    let mut cursor = 0usize;

    while cursor < line.len() {
        let Some(dot) = lower[cursor..].find('.').map(|i| cursor + i) else {
            break;
        };
        let ext_start = dot + 1;
        let Some(ext) = capture_extension_at(&lower, ext_start) else {
            cursor = ext_start;
            continue;
        };
        let ext_end = ext_start + ext.len();

        // Walk back to where the name starts: the nearest hard boundary,
        // or — when the name isn't inside a path — the last whitespace.
        let mut start = dot;
        let mut whitespace_boundary: Option<usize> = None;
        while start > 0 {
            let prev = start - 1;
            // ASCII-only scan: every boundary character is ASCII, and a
            // multi-byte char simply isn't one, so stepping a byte at a
            // time can't split a code point in a way that matters.
            let ch = bytes[prev] as char;
            if is_name_boundary(ch) {
                break;
            }
            if ch.is_ascii_whitespace() && whitespace_boundary.is_none() {
                whitespace_boundary = Some(start);
            }
            start = prev;
        }
        // No separator to the left = free text, so keep the preceding
        // words: `saved shot.png` redacts the file, not the verb.
        if start == 0 && !line.starts_with(|c: char| is_name_boundary(c)) {
            if let Some(ws) = whitespace_boundary {
                start = ws;
            }
        }

        // A bare `.png` with no stem is an extension, not a file name.
        if start == dot {
            cursor = ext_end;
            continue;
        }

        out.push_str(&line[copied..start]);
        out.push_str(CAPTURE_PLACEHOLDER);
        out.push('.');
        out.push_str(&line[ext_start..ext_end]);
        copied = ext_end;
        cursor = ext_end;
    }

    out.push_str(&line[copied..]);
    out
}

/// The capture extension starting at `from` in an already-lower-cased
/// line, when there is one and it ends at a name boundary.
fn capture_extension_at(lower: &str, from: usize) -> Option<&str> {
    let rest = &lower[from..];
    CAPTURE_EXTENSIONS.iter().find_map(|ext| {
        if !rest.starts_with(ext) {
            return None;
        }
        // `report.pngx` is not a PNG; the extension has to end here.
        let after = rest[ext.len()..].chars().next();
        match after {
            None => Some(&rest[..ext.len()]),
            Some(c) if !c.is_alphanumeric() => Some(&rest[..ext.len()]),
            Some(_) => None,
        }
    })
}

/// Pure: case-insensitive substring replacement.
///
/// `str::replace` is case-sensitive, and every Windows path in a log
/// has been through at least one API that changed its casing.
fn replace_case_insensitive(haystack: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return haystack.to_string();
    }
    let lower_haystack = haystack.to_ascii_lowercase();
    let mut out = String::with_capacity(haystack.len());
    let mut cursor = 0;
    while let Some(hit) = lower_haystack[cursor..].find(needle) {
        let start = cursor + hit;
        out.push_str(&haystack[cursor..start]);
        out.push_str(replacement);
        cursor = start + needle.len();
    }
    out.push_str(&haystack[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(paths: bool, names: bool) -> Redaction {
        Redaction::new(
            &BundleOptions {
                redact_paths: paths,
                redact_capture_names: names,
                ..Default::default()
            },
            "ada",
            r"C:\Users\ada",
        )
    }

    #[test]
    fn bundle_options_default_to_the_private_answer() {
        let o = BundleOptions::default();
        assert!(o.redact_paths);
        assert!(o.redact_capture_names);
    }

    #[test]
    fn a_home_directory_collapses_to_the_environment_variable() {
        let line = r"captures dir = C:\Users\ada\AppData\Local\Clippity\data";
        assert_eq!(
            rules(true, false).apply(line),
            r"captures dir = %USERPROFILE%\AppData\Local\Clippity\data"
        );
    }

    #[test]
    fn redaction_is_case_insensitive() {
        // The same path comes back from different Win32 APIs with
        // different casing; catching only one spelling is not redaction.
        let line = r"C:\USERS\Ada\Pictures";
        assert_eq!(rules(true, false).apply(line), r"%USERPROFILE%\Pictures");
    }

    #[test]
    fn a_bare_account_name_is_replaced_outside_a_path() {
        let line = "signed in as ada";
        assert_eq!(rules(true, false).apply(line), "signed in as <user>");
    }

    #[test]
    fn a_very_short_account_name_is_left_alone() {
        // Substituting "jo" would mangle "join", "json", "major"…
        let r = Redaction::new(&BundleOptions::default(), "jo", r"C:\Users\jo");
        assert_eq!(r.apply("json decode failed"), "json decode failed");
        // …while the home directory, where the name actually leaks, is
        // still collapsed.
        assert_eq!(r.apply(r"C:\Users\jo\x"), r"%USERPROFILE%\x");
    }

    #[test]
    fn capture_names_collapse_but_keep_their_extension() {
        // The default name template puts spaces in every capture name,
        // so a whitespace-tokenised redaction would leave the window
        // title — the identifying half — behind.
        assert_eq!(
            redact_capture_names(r"saved %USERPROFILE%\captures\Gmail - Inbox 2026-08-04.png"),
            r"saved %USERPROFILE%\captures\<capture>.png"
        );
    }

    #[test]
    fn a_capture_name_in_free_text_keeps_the_words_around_it() {
        assert_eq!(
            redact_capture_names("saved shot.png in 42 ms"),
            "saved <capture>.png in 42 ms"
        );
    }

    #[test]
    fn a_quoted_capture_name_still_redacts() {
        assert_eq!(redact_capture_names("\"shot.png\""), "\"<capture>.png\"");
        assert_eq!(
            redact_capture_names("path=Holiday clip.mp4"),
            "path=<capture>.mp4"
        );
    }

    #[test]
    fn every_capture_name_on_a_line_redacts() {
        assert_eq!(
            redact_capture_names(r"copy C:\a\one.png to C:\b\two.gif"),
            r"copy C:\a\<capture>.png to C:\b\<capture>.gif"
        );
    }

    #[test]
    fn extension_casing_survives() {
        assert_eq!(
            redact_capture_names(r"C:\a\Shot.PNG"),
            r"C:\a\<capture>.PNG"
        );
    }

    #[test]
    fn non_capture_files_are_left_alone() {
        // Redacting these would hide which app file was involved, which
        // is the diagnosis.
        for line in [
            "settings.json",
            "library.db",
            "clippity.log",
            "app.exe",
            // Not a PNG, however much it looks like one.
            r"C:\a\report.pngx",
        ] {
            assert_eq!(redact_capture_names(line), line);
        }
    }

    #[test]
    fn a_bare_extension_is_not_mistaken_for_a_file_name() {
        assert_eq!(redact_capture_names(".png"), ".png");
        assert_eq!(redact_capture_names(r"C:\a\.png"), r"C:\a\.png");
    }

    #[test]
    fn each_line_is_redacted_independently() {
        assert_eq!(
            redact_capture_names("first shot.png\nsecond clip.mp4\n"),
            "first <capture>.png\nsecond <capture>.mp4\n"
        );
    }

    #[test]
    fn disabled_rules_change_nothing() {
        let line = r"C:\Users\ada\captures\secret.png";
        assert_eq!(Redaction::none().apply(line), line);
        assert!(!Redaction::none().is_active());
    }

    #[test]
    fn each_rule_can_be_turned_off_independently() {
        let line = r"C:\Users\ada\captures\secret.png";
        assert_eq!(
            rules(false, true).apply(line),
            r"C:\Users\ada\captures\<capture>.png"
        );
        assert_eq!(
            rules(true, false).apply(line),
            r"%USERPROFILE%\captures\secret.png"
        );
    }

    #[test]
    fn a_formatted_log_line_splits_into_its_parts() {
        let line = "2026-08-04T12:34:56.789012Z  INFO clippity_lib: starting version=0.1.0";
        let parsed = parse_log_line(7, line);
        assert_eq!(parsed.seq, 7);
        assert_eq!(parsed.level, "info");
        assert_eq!(parsed.timestamp, "2026-08-04T12:34:56.789012Z");
        assert_eq!(parsed.message, "clippity_lib: starting version=0.1.0");
    }

    #[test]
    fn a_five_letter_level_parses_too() {
        // The subscriber pads the level to five columns, so `INFO` has
        // two spaces before it and `ERROR` has one. Both are log lines.
        let parsed = parse_log_line(0, "2026-08-04T12:34:56.789012Z ERROR frontend: boom");
        assert_eq!(parsed.level, "error");
        assert_eq!(parsed.message, "frontend: boom");
    }

    #[test]
    fn a_line_that_is_not_a_log_record_survives_whole() {
        // Panic backtraces arrive like this, and they are the lines a
        // crash report exists for.
        let line = "   3: core::panicking::panic_fmt";
        let parsed = parse_log_line(0, line);
        assert!(parsed.level.is_empty());
        assert!(parsed.timestamp.is_empty());
        assert_eq!(parsed.message, line);
    }

    #[test]
    fn drop_rate_is_measured_against_what_the_source_produced() {
        let d = RecorderDiagnostics {
            frames: 90,
            dropped: 10,
            ..Default::default()
        };
        assert!((d.drop_rate_pct() - 10.0).abs() < f32::EPSILON);
        assert_eq!(RecorderDiagnostics::default().drop_rate_pct(), 0.0);
    }

    #[test]
    fn a_session_with_no_duration_reports_no_bitrate() {
        // Better no number than a division dressed up as data.
        let d = RecorderDiagnostics {
            bytes: 1_000,
            duration_ms: 0,
            ..Default::default()
        };
        assert_eq!(d.avg_bitrate_kbps(), None);
    }

    #[test]
    fn average_bitrate_is_bytes_over_seconds() {
        // 1 MB over 8 s = 1 Mbit/s = 1000 kbit/s.
        let d = RecorderDiagnostics {
            bytes: 1_000_000,
            duration_ms: 8_000,
            ..Default::default()
        };
        assert_eq!(d.avg_bitrate_kbps(), Some(1_000));
    }

    #[test]
    fn only_the_webview_cache_needs_a_restart() {
        assert!(CacheTarget::Webview.needs_restart());
        for t in [
            CacheTarget::Thumbnails,
            CacheTarget::Models,
            CacheTarget::Temp,
            CacheTarget::Logs,
        ] {
            assert!(!t.needs_restart(), "{:?}", t);
        }
    }

    #[test]
    fn cache_targets_serialize_kebab_case() {
        assert_eq!(
            serde_json::to_string(&CacheTarget::Thumbnails).unwrap(),
            "\"thumbnails\""
        );
    }
}
