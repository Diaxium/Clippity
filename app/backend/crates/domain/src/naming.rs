//! Capture **file-naming** engine — pure, no I/O, no platform code.
//!
//! Turns a user-configurable template (Settings → General) plus the
//! capture's [`CaptureSource`] into a filesystem-safe file *stem* (the
//! part before `.png`). Replaces the old opaque `clippity-{epoch_ms}`
//! name with something a user can recognise at a glance — the capture
//! mode, the dominant window when known, plus a readable local date/time.
//!
//! The template reads the *same* [`CaptureSource`] the metadata sidecar
//! is built from (`domain::metadata`), so a capture's name and its
//! recorded provenance can never disagree about where it came from.
//!
//! Tokens supported in a template:
//!   `{label}`  — the capture type plus the window title when known, else
//!                just the capture type. This is the "smart" token the
//!                default template uses so a name reads
//!                "Region - GitHub - PR #42 - Chrome - …" when we know the
//!                source window and "Region - …" when we don't.
//!   `{window}` — the sanitised dominant-window title, or empty when unknown.
//!   `{app}`    — the sanitised source application name (`Chrome`,
//!                `Code`, …), or empty when the owning process could not
//!                be resolved. Shorter and far more stable than
//!                `{window}`, whose title changes with every tab.
//!   `{type}`   — the capture-type label (Fullscreen / Region / Window /
//!                Freehand / Multi-Area / Scrolling / Panoramic / …).
//!   `{date}`   — local calendar date, `YYYY-MM-DD`.
//!   `{time}`   — local wall-clock time, `h.mm.ss AM/PM` (colon-free so it
//!                is a legal Windows filename).
//! Unknown `{tokens}` expand to empty so a typo can't leak braces into a
//! filename. The clock itself is impure and lives in
//! `services::capture_io::local_now`, which fills a [`LocalTime`]; this
//! module only *formats* an already-resolved time so every rule here is
//! unit-testable without a clock.

use crate::metadata::CaptureSource;

/// Built-in default when `general.name_template` is blank. Mode-led,
/// adding the dominant window when known, then a readable timestamp.
pub const DEFAULT_TEMPLATE: &str = "{label} - {date} {time}";

/// Per-segment character cap. Window titles can be paragraph-long
/// (browsers append the full page title); keep one segment from
/// dominating the name (and blowing past `MAX_PATH`).
const SEGMENT_MAX_CHARS: usize = 80;

/// Whole-stem character cap. Leaves comfortable headroom under Windows'
/// 260-char `MAX_PATH` for the captures dir + a ` (10).png` collision
/// suffix.
const STEM_MAX_CHARS: usize = 150;

/// Fallback stem when a template + context sanitise down to nothing.
const FALLBACK_STEM: &str = "Clippity";

/// A broken-down **local** wall-clock instant. Produced by the platform
/// clock (`GetLocalTime` on Windows); kept as plain integers so the
/// formatter is pure and testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTime {
    pub year: i32,
    /// 1–12
    pub month: u32,
    /// 1–31
    pub day: u32,
    /// 0–23
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

/// Render `template` against the capture's `source` and a resolved
/// local `time` into a sanitised, collision-free-*shape* file stem (no
/// extension, no directory). The caller appends the extension and
/// resolves on-disk collisions. A blank template falls back to
/// [`DEFAULT_TEMPLATE`].
pub fn render(template: &str, source: &CaptureSource, time_of: LocalTime) -> String {
    let trimmed = template.trim();
    let template = if trimmed.is_empty() {
        DEFAULT_TEMPLATE
    } else {
        trimmed
    };

    // Sanitise token values once. An empty window collapses the `{window}`
    // token; an empty type can't happen in practice but we guard it so
    // `{label}` always has *something*.
    let window = source.window.map(sanitize_segment).filter(|s| !s.is_empty());
    let app = source.app.map(sanitize_segment).filter(|s| !s.is_empty());
    let type_label = {
        let t = sanitize_segment(source.type_label);
        if t.is_empty() {
            "Capture".to_string()
        } else {
            t
        }
    };
    let label = match window.as_deref() {
        Some(window) => format!("{type_label} - {window}"),
        None => type_label.clone(),
    };
    let date = format_date(&time_of);
    let time = format_time(&time_of);

    let mut out = String::with_capacity(template.len() + 32);
    let mut rest = template;
    loop {
        match rest.find('{') {
            None => {
                out.push_str(rest);
                break;
            }
            Some(open) => {
                out.push_str(&rest[..open]);
                let after = &rest[open + 1..];
                match after.find('}') {
                    // Unterminated `{` — emit it literally and continue
                    // scanning the remainder.
                    None => {
                        out.push('{');
                        rest = after;
                    }
                    Some(close) => {
                        let name = &after[..close];
                        out.push_str(match name {
                            "label" => &label,
                            "window" => window.as_deref().unwrap_or(""),
                            "app" => app.as_deref().unwrap_or(""),
                            "type" => &type_label,
                            "date" => &date,
                            "time" => &time,
                            // Unknown token → nothing (never leak braces).
                            _ => "",
                        });
                        rest = &after[close + 1..];
                    }
                }
            }
        }
    }

    finalize_stem(&out)
}

/// `YYYY-MM-DD`.
fn format_date(t: &LocalTime) -> String {
    format!("{:04}-{:02}-{:02}", t.year, t.month, t.day)
}

/// `h.mm.ss AM/PM` — 12-hour, colon-free (colons are illegal in Windows
/// filenames). Seconds are included so two captures in the same minute
/// don't immediately collide.
fn format_time(t: &LocalTime) -> String {
    let (h12, meridiem) = match t.hour {
        0 => (12, "AM"),
        1..=11 => (t.hour, "AM"),
        12 => (12, "PM"),
        h => (h - 12, "PM"),
    };
    format!("{}.{:02}.{:02} {}", h12, t.minute, t.second, meridiem)
}

/// `true` if `ch` can't appear in a Windows filename. The reserved set is
/// `< > : " / \ | ? *`; control characters are handled separately.
fn is_illegal(ch: char) -> bool {
    matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
}

/// Clean a single token value (a window title, a type label): replace
/// every illegal / control character with a space, collapse internal
/// whitespace runs, trim, and cap the length. May return empty (e.g. a
/// title that was nothing but slashes).
fn sanitize_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for ch in s.chars() {
        let cleaned = if is_illegal(ch) || ch.is_control() {
            ' '
        } else {
            ch
        };
        if cleaned == ' ' {
            // Defer spaces so leading + collapsed runs never land.
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(cleaned);
        }
    }
    truncate_chars(out.trim(), SEGMENT_MAX_CHARS)
}

/// Final pass on the assembled stem: collapse whitespace, strip leading /
/// trailing dots & spaces (Windows silently drops trailing ones, and a
/// leading dot would make a hidden file the library scanner skips), cap
/// the length, dodge reserved device names, and never return empty.
fn finalize_stem(s: &str) -> String {
    // Collapse any whitespace runs the template literals may have
    // introduced (e.g. an empty `{window}` leaving a double space).
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let stripped = strip_dots_spaces(&collapsed);
    let capped = truncate_chars(&stripped, STEM_MAX_CHARS);
    let capped = strip_dots_spaces(&capped);

    if capped.is_empty() {
        return FALLBACK_STEM.to_string();
    }
    if is_reserved_name(&capped) {
        // Win32 reserves these device names regardless of extension.
        return format!("_{capped}");
    }
    capped
}

fn strip_dots_spaces(s: &str) -> String {
    s.trim_matches(|c| c == '.' || c == ' ').to_string()
}

/// Truncate to at most `max` characters (not bytes — never split a
/// multi-byte char), trimming any trailing space the cut exposes.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    cut.trim_end().to_string()
}

/// Case-insensitive match against the Win32 reserved device names
/// (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`). A file
/// whose stem is one of these can't be created on Windows.
fn is_reserved_name(stem: &str) -> bool {
    let upper = stem.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.len() == 4
            && upper.as_bytes()[3].is_ascii_digit()
            && upper.as_bytes()[3] != b'0')
}

/// Convert seconds-since-Unix-epoch into a broken-down **UTC** time.
/// Used only as the non-Windows fallback for the platform clock (Windows
/// uses `GetLocalTime`, which already accounts for the local zone). Pure
/// + exact (Howard Hinnant's civil-from-days), so it is unit-tested here.
pub fn civil_from_unix(secs: u64) -> LocalTime {
    let days = (secs / 86_400) as i64;
    let rem = (secs % 86_400) as u32;
    let hour = rem / 3_600;
    let minute = (rem % 3_600) / 60;
    let second = rem % 60;

    // days is non-negative for any post-epoch instant, so the era math
    // below stays in its happy path.
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1, 12]
    let year = (y + if month <= 2 { 1 } else { 0 }) as i32;

    LocalTime {
        year,
        month,
        day,
        hour,
        minute,
        second,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(year: i32, month: u32, day: u32, hour: u32, minute: u32, second: u32) -> LocalTime {
        LocalTime {
            year,
            month,
            day,
            hour,
            minute,
            second,
        }
    }

    /// A source that knows the window but not the owning app — the
    /// shape every pre-{app} test was written against.
    fn src<'a>(window: Option<&'a str>, type_label: &'a str) -> CaptureSource<'a> {
        CaptureSource::from_mode(type_label).with_window(window, None)
    }

    // ---------- default template + happy paths ----------

    #[test]
    fn blank_template_uses_mode_and_window_default() {
        let s = render(
            "",
            &src(Some("GitHub - PR #42 - Chrome"), "Fullscreen"), at(2026, 6, 13, 14, 34, 15),
        );
        assert_eq!(
            s,
            "Fullscreen - GitHub - PR #42 - Chrome - 2026-06-13 2.34.15 PM"
        );
    }

    #[test]
    fn label_falls_back_to_type_when_no_window() {
        let s = render(
            "{label} - {date} {time}",
            &src(None, "Region"), at(2026, 6, 12, 16, 18, 55));
        assert_eq!(s, "Region - 2026-06-12 4.18.55 PM");
    }

    #[test]
    fn whitespace_only_template_falls_back_to_default() {
        let s = render("   ", &src(None, "Window"), at(2026, 1, 2, 9, 7, 4));
        assert_eq!(s, "Window - 2026-01-02 9.07.04 AM");
    }

    // ---------- individual tokens ----------

    #[test]
    fn every_token_expands() {
        let s = render(
            "{type}_{window}_{label}_{date}_{time}",
            &src(Some("Figma"), "Region"), at(2026, 12, 1, 0, 5, 9),
        );
        // window present => label == type + window; midnight => 12.05.09 AM
        assert_eq!(s, "Region_Figma_Region - Figma_2026-12-01_12.05.09 AM");
    }

    #[test]
    fn empty_window_token_collapses_cleanly() {
        // `{window}` with no window leaves an empty slot; the surrounding
        // spaces collapse and the leading separator is stripped.
        let s = render(
            "{window} {date}",
            &src(None, "Region"), at(2026, 6, 13, 13, 0, 0),
        );
        assert_eq!(s, "2026-06-13");
    }

    #[test]
    fn unknown_token_is_stripped_not_leaked() {
        let s = render(
            "{bogus}{date}",
            &src(None, "Region"), at(2026, 6, 13, 13, 0, 0),
        );
        assert_eq!(s, "2026-06-13");
    }

    #[test]
    fn unterminated_brace_is_literal() {
        let s = render("a{date", &src(None, "Region"), at(2026, 6, 13, 13, 0, 0));
        assert_eq!(s, "a{date");
    }

    // ---------- time formatting edges ----------

    #[test]
    fn midnight_and_noon_format_12_hour() {
        assert_eq!(format_time(&at(0, 0, 0, 0, 0, 0)), "12.00.00 AM");
        assert_eq!(format_time(&at(0, 0, 0, 12, 0, 0)), "12.00.00 PM");
        assert_eq!(format_time(&at(0, 0, 0, 23, 59, 59)), "11.59.59 PM");
        assert_eq!(format_time(&at(0, 0, 0, 1, 2, 3)), "1.02.03 AM");
    }

    // ---------- sanitisation ----------

    #[test]
    fn illegal_characters_in_window_become_spaces() {
        // A title full of path/illegal chars must not produce sub-paths
        // or break the filename.
        let s = render(
            "{window}",
            &src(
                Some("a/b\\c:d*e?f\"g<h>i|j"), "Region"), at(2026, 6, 13, 13, 0, 0),
        );
        assert_eq!(s, "a b c d e f g h i j");
        assert!(!s.contains('/') && !s.contains('\\') && !s.contains(':'));
    }

    #[test]
    fn control_chars_and_runs_collapse() {
        let s = render(
            "{window}",
            &src(Some("  hello\t\n  world  "),
                "Region"), at(2026, 6, 13, 13, 0, 0),
        );
        assert_eq!(s, "hello world");
    }

    #[test]
    fn trailing_dots_and_spaces_are_stripped() {
        // Windows silently drops trailing dots/spaces — strip them so the
        // on-disk name matches what we computed.
        let s = render(
            "{window}",
            &src(Some("report..."), "Region"), at(2026, 6, 13, 13, 0, 0));
        assert_eq!(s, "report");
    }

    #[test]
    fn never_starts_with_a_dot() {
        // A leading dot would make a hidden file the library scanner skips.
        let s = render(
            "{window} {date}",
            &src(Some(".env secrets"), "Region"), at(2026, 6, 13, 13, 0, 0),
        );
        assert!(!s.starts_with('.'), "got {s}");
        assert_eq!(s, "env secrets 2026-06-13");
    }

    #[test]
    fn reserved_device_name_is_escaped() {
        assert_eq!(
            render(
                "{window}",
                &src(Some("CON"), "Region"), at(2026, 6, 13, 1, 0, 0)
            ),
            "_CON"
        );
        assert_eq!(
            render(
                "{window}",
                &src(Some("com1"), "Region"), at(2026, 6, 13, 1, 0, 0)
            ),
            "_com1"
        );
        // Not actually reserved — COM0 / a longer name pass through.
        assert_eq!(
            render(
                "{window}",
                &src(Some("COM0"), "Region"), at(2026, 6, 13, 1, 0, 0)
            ),
            "COM0"
        );
        assert_eq!(
            render(
                "{window}",
                &src(Some("CONSOLE"), "Region"), at(2026, 6, 13, 1, 0, 0)
            ),
            "CONSOLE"
        );
    }

    #[test]
    fn empty_everything_falls_back_to_clippity() {
        // A title of only illegal chars + a template that is only that
        // token sanitises to nothing → the safety stem.
        let s = render("{window}", &src(Some("///"), ""), at(2026, 6, 13, 1, 0, 0));
        assert_eq!(s, FALLBACK_STEM);
    }

    // ---------- {app} ----------

    #[test]
    fn app_token_renders_the_source_application() {
        let source = CaptureSource::from_mode("Region")
            .with_window(Some("GitHub - PR #42 - Chrome"), Some("Chrome"));
        let s = render("{app} {date}", &source, at(2026, 6, 13, 1, 0, 0));
        assert_eq!(s, "Chrome 2026-06-13");
    }

    #[test]
    fn app_token_is_empty_when_the_process_is_unresolved() {
        // `src` never sets an app — the template must collapse cleanly
        // rather than leaving a stray separator or a literal brace.
        let s = render("{app}-{type}", &src(Some("Notepad"), "Region"), at(2026, 6, 13, 1, 0, 0));
        assert_eq!(s, "-Region");
    }

    #[test]
    fn app_token_is_sanitised_like_any_other_segment() {
        let source = CaptureSource::from_mode("Region").with_window(None, Some("we:ird/app"));
        let s = render("{app}", &source, at(2026, 6, 13, 1, 0, 0));
        assert_eq!(s, "we ird app");
    }

    #[test]
    fn app_does_not_leak_into_the_label_token() {
        // `{label}` is deliberately type + *window*; adding the app there
        // would rename every existing capture's shape.
        let source = CaptureSource::from_mode("Region").with_window(Some("Doc"), Some("Word"));
        let s = render("{label}", &source, at(2026, 6, 13, 1, 0, 0));
        assert_eq!(s, "Region - Doc");
    }

    #[test]
    fn long_window_title_is_capped() {
        let long = "x".repeat(500);
        let s = render(
            "{window}",
            &src(Some(&long), "Region"), at(2026, 6, 13, 1, 0, 0),
        );
        assert!(s.chars().count() <= STEM_MAX_CHARS);
        assert!(s.chars().count() <= SEGMENT_MAX_CHARS);
    }

    // ---------- civil_from_unix ----------

    #[test]
    fn epoch_zero_is_1970() {
        assert_eq!(civil_from_unix(0), at(1970, 1, 1, 0, 0, 0));
    }

    #[test]
    fn known_instant_round_trips() {
        // 2026-06-13T14:34:15Z = 1_781_361_255 (verified against a date lib).
        assert_eq!(civil_from_unix(1_781_361_255), at(2026, 6, 13, 14, 34, 15));
    }

    #[test]
    fn leap_day_handled() {
        // 2024-02-29T00:00:00Z = 1_709_164_800.
        assert_eq!(civil_from_unix(1_709_164_800), at(2024, 2, 29, 0, 0, 0));
    }
}
