//! Tracing setup — console + a rotating on-disk log, with the severity
//! floor changeable at runtime.
//!
//! Three things distinguish this from the one-liner it grew out of:
//!
//! 1. **The level is a setting, not an environment variable.** Settings
//!    → Advanced writes `developer.backendLog`, and [`set_level`] moves
//!    the floor for the running process. An explicit `CLIPPITY_LOG` /
//!    `RUST_LOG` still wins outright — a developer who set one meant it,
//!    and silently overriding it from a settings file would be worse
//!    than ignoring the setting.
//! 2. **The log is written to disk**, to size-capped rotating files
//!    under `<data>/logs`. This is on for every user, not just
//!    developers: an exported diagnostics bundle is worth nothing if
//!    the session that produced the bug was never recorded.
//! 3. **The frontend logs here too.** Records forwarded over
//!    `developer_log` land in the same file, in order, so a bug that
//!    crosses the IPC boundary reads as one timeline instead of two.
//!
//! Nothing here transmits anything: the files stay on the machine until
//! a user exports a bundle, and the export path redacts them (see
//! `domain::developer::Redaction`).

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tracing::Level;
use tracing_subscriber::{filter::filter_fn, fmt, prelude::*, EnvFilter};

/// Target every record forwarded from the frontend carries, so the file
/// says which half of the app produced a line.
pub const FRONTEND_TARGET: &str = "frontend";

/// Base name of the live log file. Rotated files are `clippity.1.log`
/// (most recent) through `clippity.<retain>.log`.
const LOG_STEM: &str = "clippity";
const LOG_EXT: &str = "log";

/// Bytes read back when tailing the log. The viewer shows a window of
/// recent lines, not the file — reading a 64 MiB file to render 500
/// lines would be the wrong trade in the one place a user goes when the
/// app is already misbehaving.
const TAIL_WINDOW_BYTES: u64 = 512 * 1024;

/// Runtime severity floor, as a [`Level`] rank. An atomic rather than a
/// `reload::Handle` because that is all this needs: one number, read on
/// every callsite, written from a settings update.
static LEVEL: AtomicU8 = AtomicU8::new(RANK_INFO);

/// True when `CLIPPITY_LOG` / `RUST_LOG` pinned the filter at startup,
/// in which case [`set_level`] is a documented no-op.
static ENV_PINNED: AtomicBool = AtomicBool::new(false);

const RANK_OFF: u8 = 0;
const RANK_ERROR: u8 = 1;
const RANK_WARN: u8 = 2;
const RANK_INFO: u8 = 3;
const RANK_DEBUG: u8 = 4;
const RANK_TRACE: u8 = 5;

/// Pure: map a level name onto its rank. Unknown input becomes `info` —
/// a log level is never worth failing a settings save over.
fn rank_of(level: &str) -> u8 {
    match level.trim().to_ascii_lowercase().as_str() {
        "off" | "none" | "silent" => RANK_OFF,
        "error" => RANK_ERROR,
        "warn" | "warning" => RANK_WARN,
        "debug" => RANK_DEBUG,
        "trace" => RANK_TRACE,
        _ => RANK_INFO,
    }
}

fn rank_of_tracing(level: &Level) -> u8 {
    match *level {
        Level::ERROR => RANK_ERROR,
        Level::WARN => RANK_WARN,
        Level::INFO => RANK_INFO,
        Level::DEBUG => RANK_DEBUG,
        Level::TRACE => RANK_TRACE,
    }
}

/// The single on-disk sink, shared by the file layer and by the
/// tail/clear helpers.
static SINK: OnceLock<Arc<Mutex<FileSink>>> = OnceLock::new();

fn sink() -> &'static Arc<Mutex<FileSink>> {
    SINK.get_or_init(|| Arc::new(Mutex::new(FileSink::idle())))
}

/// Install the subscriber. Call once, as early in `main` as possible —
/// before this runs, `tracing` records go nowhere.
///
/// The on-disk half stays dormant until [`configure_files`] supplies a
/// directory, because the app data root isn't resolved this early.
pub fn init() {
    let env = EnvFilter::try_from_env("CLIPPITY_LOG")
        .or_else(|_| EnvFilter::try_from_default_env())
        .ok();

    // The two layers are built per branch rather than once above it:
    // a `fmt::Layer`'s type carries the subscriber it wraps, so a layer
    // built before the match would have that type fixed by whichever
    // branch used it first.
    macro_rules! console_layer {
        () => {
            fmt::layer().with_target(false)
        };
    }
    macro_rules! file_layer {
        () => {
            fmt::layer()
                .with_target(true)
                .with_ansi(false)
                .with_writer(SinkWriter)
        };
    }

    match env {
        // An explicit filter wins outright, directives and all. The
        // settings level is then a no-op for this process, which
        // `set_level` reports rather than pretending otherwise.
        Some(filter) => {
            ENV_PINNED.store(true, Ordering::Relaxed);
            tracing_subscriber::registry()
                .with(filter)
                .with(console_layer!())
                .with(file_layer!())
                .init();
        }
        None => {
            tracing_subscriber::registry()
                .with(filter_fn(|meta| {
                    // Frontend records arrive already filtered by the
                    // frontend's own threshold; re-filtering them against
                    // the backend floor would make "frontend: debug,
                    // backend: info" quietly drop what the user asked for.
                    if meta.target() == FRONTEND_TARGET {
                        return LEVEL.load(Ordering::Relaxed) != RANK_OFF;
                    }
                    let floor = LEVEL.load(Ordering::Relaxed);
                    floor != RANK_OFF && rank_of_tracing(meta.level()) <= floor
                }))
                .with(console_layer!())
                .with(file_layer!())
                .init();
        }
    }
}

/// Move the severity floor for the running process.
///
/// Returns `false` when an environment filter pinned the level at
/// startup, so the caller can say so rather than showing a control that
/// silently does nothing.
pub fn set_level(level: &str) -> bool {
    if ENV_PINNED.load(Ordering::Relaxed) {
        return false;
    }
    LEVEL.store(rank_of(level), Ordering::Relaxed);
    true
}

/// True when `CLIPPITY_LOG` / `RUST_LOG` is driving the filter.
pub fn env_pinned() -> bool {
    ENV_PINNED.load(Ordering::Relaxed)
}

/// Point the on-disk log at `dir` and set its caps.
///
/// Idempotent and cheap to call on every settings save: an unchanged
/// configuration leaves the open file alone, and turning `enabled` off
/// closes it rather than leaving a handle on a file the user may want
/// to delete.
pub fn configure_files(dir: &Path, enabled: bool, max_bytes: u64, retain: u32) {
    let mut sink = lock_sink();
    sink.configure(dir, enabled, max_bytes, retain);
}

/// The live log file's path, or `None` when disk logging is off.
pub fn current_file() -> Option<PathBuf> {
    let sink = lock_sink();
    sink.enabled.then(|| sink.live_path())
}

/// The log directory, whether or not writing is enabled.
pub fn log_dir() -> Option<PathBuf> {
    let sink = lock_sink();
    sink.dir.clone()
}

/// Every log file that exists, newest first (live, then rotated).
pub fn log_files() -> Vec<PathBuf> {
    let sink = lock_sink();
    let Some(dir) = sink.dir.clone() else {
        return Vec::new();
    };
    let retain = sink.retain;
    drop(sink);

    let mut files = Vec::new();
    let live = dir.join(format!("{LOG_STEM}.{LOG_EXT}"));
    if live.is_file() {
        files.push(live);
    }
    for i in 1..=retain {
        let path = dir.join(format!("{LOG_STEM}.{i}.{LOG_EXT}"));
        if path.is_file() {
            files.push(path);
        }
    }
    files
}

/// Total bytes across every retained log file.
pub fn total_bytes() -> u64 {
    log_files()
        .iter()
        .filter_map(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .sum()
}

/// The last `limit` lines of the log, oldest first.
///
/// Reads a bounded window from the end of the live file (falling back
/// to the newest rotated file when the live one has just rotated), so
/// the viewer costs the same whether the log is 1 KiB or the 64 MiB
/// ceiling.
pub fn tail(limit: usize) -> Vec<String> {
    if limit == 0 {
        return Vec::new();
    }
    let mut lines: Vec<String> = Vec::new();
    for path in log_files().into_iter().take(2) {
        // Flush what is buffered in the open handle first, or the most
        // recent lines — the ones a user is watching for — aren't there.
        flush();
        let Ok(text) = read_tail(&path, TAIL_WINDOW_BYTES) else {
            continue;
        };
        let mut file_lines: Vec<String> = text
            .lines()
            .map(|l| l.to_string())
            .filter(|l| !l.trim().is_empty())
            .collect();
        // Newest file is read first, so older files prepend.
        file_lines.append(&mut lines);
        lines = file_lines;
        if lines.len() >= limit {
            break;
        }
    }
    let start = lines.len().saturating_sub(limit);
    lines.split_off(start)
}

/// Flush the buffered writer so a tail (or an export) sees the lines
/// this session has already produced.
pub fn flush() {
    let mut sink = lock_sink();
    sink.flush();
}

/// Delete every rotated file and truncate the live one.
///
/// The live file is truncated rather than removed so the running
/// process keeps writing to a valid handle — deleting a file out from
/// under an open handle on Windows either fails or leaves the writer
/// appending to a ghost.
pub fn clear() -> io::Result<()> {
    let mut sink = lock_sink();
    sink.clear()
}

/// Record one line forwarded from the frontend.
///
/// Emitted under [`FRONTEND_TARGET`] so a reader can tell the halves
/// apart, and at a `tracing` level matching what the frontend called —
/// `tracing`'s macros need a const level, hence the match.
pub fn log_frontend(level: &str, module: &str, message: &str, context: Option<&str>) {
    let context = context.unwrap_or("");
    match rank_of(level) {
        RANK_OFF => {}
        RANK_ERROR => {
            tracing::error!(target: FRONTEND_TARGET, module, context, "{message}")
        }
        RANK_WARN => tracing::warn!(target: FRONTEND_TARGET, module, context, "{message}"),
        RANK_DEBUG => {
            tracing::debug!(target: FRONTEND_TARGET, module, context, "{message}")
        }
        RANK_TRACE => {
            tracing::trace!(target: FRONTEND_TARGET, module, context, "{message}")
        }
        _ => tracing::info!(target: FRONTEND_TARGET, module, context, "{message}"),
    }
}

fn lock_sink() -> std::sync::MutexGuard<'static, FileSink> {
    // A poisoned log sink must not take the app with it: whatever
    // panicked while holding it, the worst case here is a garbled line.
    sink().lock().unwrap_or_else(|e| e.into_inner())
}

/// Read up to `max` bytes from the end of `path`, snapped forward to
/// the next line break so the window never begins mid-line.
fn read_tail(path: &Path, max: u64) -> io::Result<String> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let from = len.saturating_sub(max);
    file.seek(SeekFrom::Start(from))?;
    let mut buf = Vec::with_capacity(max.min(len) as usize);
    file.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if from == 0 {
        return Ok(text);
    }
    Ok(match text.find('\n') {
        Some(i) => text[i + 1..].to_string(),
        None => text,
    })
}

/// The rotating file behind the `tracing` file layer.
///
/// Rotation is by size rather than by day: a session is the unit of
/// diagnosis here, and a user who reports a bug after a week of uptime
/// would otherwise have their evidence split across seven files while a
/// user who restarts hourly would have one line in each.
struct FileSink {
    dir: Option<PathBuf>,
    file: Option<File>,
    /// Bytes in the live file. Tracked rather than `metadata()`-ed per
    /// write — this runs on every log line.
    written: u64,
    max_bytes: u64,
    retain: u32,
    enabled: bool,
}

impl FileSink {
    fn idle() -> Self {
        Self {
            dir: None,
            file: None,
            written: 0,
            max_bytes: 8 * 1024 * 1024,
            retain: 5,
            enabled: false,
        }
    }

    fn live_path(&self) -> PathBuf {
        self.dir
            .clone()
            .unwrap_or_default()
            .join(format!("{LOG_STEM}.{LOG_EXT}"))
    }

    fn rotated_path(&self, index: u32) -> PathBuf {
        self.dir
            .clone()
            .unwrap_or_default()
            .join(format!("{LOG_STEM}.{index}.{LOG_EXT}"))
    }

    fn configure(&mut self, dir: &Path, enabled: bool, max_bytes: u64, retain: u32) {
        let moved = self.dir.as_deref() != Some(dir);
        self.dir = Some(dir.to_path_buf());
        self.max_bytes = max_bytes.max(1);
        self.retain = retain.max(1);
        if !enabled {
            self.enabled = false;
            // Drop the handle so the file can be deleted or moved.
            self.file = None;
            return;
        }
        self.enabled = true;
        if moved {
            self.file = None;
        }
    }

    /// The open live file, opening (and creating the directory) on first
    /// use. `None` when disk logging is off or the file can't be opened
    /// — a log that cannot be written must never fail the operation
    /// being logged.
    fn file(&mut self) -> Option<&mut File> {
        if !self.enabled {
            return None;
        }
        if self.file.is_none() {
            let dir = self.dir.clone()?;
            if fs::create_dir_all(&dir).is_err() {
                return None;
            }
            let path = self.live_path();
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .ok()?;
            self.written = file.metadata().map(|m| m.len()).unwrap_or(0);
            self.file = Some(file);
        }
        self.file.as_mut()
    }

    fn write_line(&mut self, buf: &[u8]) {
        if self.file().is_none() {
            return;
        }
        let wrote = match self.file.as_mut() {
            Some(file) => file.write_all(buf).is_ok(),
            None => false,
        };
        if wrote {
            self.written += buf.len() as u64;
            if self.written >= self.max_bytes {
                self.rotate();
            }
        }
    }

    fn flush(&mut self) {
        if let Some(file) = self.file.as_mut() {
            let _ = file.flush();
        }
    }

    /// Shift `clippity.log` → `clippity.1.log`, each `clippity.N.log`
    /// → `N+1`, and drop whatever falls off the end.
    ///
    /// Best-effort at every step: a rename that fails (a file open in a
    /// viewer, say) leaves the live file where it is and the next write
    /// simply tries again once it has grown further.
    fn rotate(&mut self) {
        if self.dir.is_none() {
            return;
        }
        self.file = None;
        let _ = fs::remove_file(self.rotated_path(self.retain));
        for i in (1..self.retain).rev() {
            let from = self.rotated_path(i);
            if from.is_file() {
                let _ = fs::rename(&from, self.rotated_path(i + 1));
            }
        }
        let live = self.live_path();
        if live.is_file() && fs::rename(&live, self.rotated_path(1)).is_err() {
            // Couldn't rotate — keep appending rather than losing the
            // session, and re-check on the next write.
            self.written = 0;
            return;
        }
        self.written = 0;
    }

    fn clear(&mut self) -> io::Result<()> {
        let Some(dir) = self.dir.clone() else {
            return Ok(());
        };
        self.file = None;
        self.written = 0;
        for i in 1..=self.retain {
            let path = dir.join(format!("{LOG_STEM}.{i}.{LOG_EXT}"));
            if path.is_file() {
                fs::remove_file(path)?;
            }
        }
        let live = dir.join(format!("{LOG_STEM}.{LOG_EXT}"));
        if live.is_file() {
            // Truncate, don't unlink: the running process holds — or is
            // about to re-open — this path.
            File::create(&live)?;
        }
        Ok(())
    }
}

/// `MakeWriter` for the file layer. Zero-sized: the sink is a process
/// global, and the layer is built before the app data directory that
/// configures it is even known.
struct SinkWriter;

impl io::Write for SinkWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        lock_sink().write_line(buf);
        // Always "successful": a full disk or a locked file must not
        // surface as an error inside whatever emitted the record.
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        lock_sink().flush();
        Ok(())
    }
}

impl<'a> fmt::MakeWriter<'a> for SinkWriter {
    type Writer = SinkWriter;

    fn make_writer(&'a self) -> Self::Writer {
        SinkWriter
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    static NONCE: AtomicU64 = AtomicU64::new(0);

    fn scratch(label: &str) -> PathBuf {
        let n = NONCE.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("clippity-logging-{label}-{n}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// A sink pointed at its own scratch directory — the process-global
    /// one is shared by the whole test binary, so these use their own.
    fn sink_in(dir: &Path, max_bytes: u64, retain: u32) -> FileSink {
        let mut s = FileSink::idle();
        s.configure(dir, true, max_bytes, retain);
        s
    }

    #[test]
    fn level_names_parse_loosely() {
        assert_eq!(rank_of("TRACE"), RANK_TRACE);
        assert_eq!(rank_of(" warning "), RANK_WARN);
        assert_eq!(rank_of("none"), RANK_OFF);
        assert_eq!(rank_of("nonsense"), RANK_INFO);
    }

    #[test]
    fn a_line_lands_in_the_live_file() {
        let dir = scratch("write");
        let mut sink = sink_in(&dir, 1024, 3);
        sink.write_line(b"hello\n");
        sink.flush();
        let text = fs::read_to_string(dir.join("clippity.log")).unwrap();
        assert_eq!(text, "hello\n");
    }

    #[test]
    fn nothing_is_written_while_disk_logging_is_off() {
        let dir = scratch("disabled");
        let mut sink = FileSink::idle();
        sink.configure(&dir, false, 1024, 3);
        sink.write_line(b"hello\n");
        assert!(!dir.join("clippity.log").exists());
    }

    #[test]
    fn the_file_rotates_at_the_size_cap() {
        let dir = scratch("rotate");
        let mut sink = sink_in(&dir, 16, 3);
        sink.write_line(b"0123456789abcdef\n"); // over the cap
        sink.write_line(b"second\n");
        sink.flush();
        assert_eq!(
            fs::read_to_string(dir.join("clippity.1.log")).unwrap(),
            "0123456789abcdef\n"
        );
        assert_eq!(
            fs::read_to_string(dir.join("clippity.log")).unwrap(),
            "second\n"
        );
    }

    #[test]
    fn rotation_drops_the_oldest_file_beyond_the_retained_count() {
        let dir = scratch("retain");
        let mut sink = sink_in(&dir, 8, 2);
        for i in 0..4 {
            sink.write_line(format!("line-{i}\n").as_bytes());
        }
        sink.flush();
        // retain = 2 → live + .1 + .2, and nothing further.
        assert!(dir.join("clippity.1.log").is_file());
        assert!(dir.join("clippity.2.log").is_file());
        assert!(!dir.join("clippity.3.log").exists());
    }

    #[test]
    fn reopening_an_existing_file_appends_rather_than_truncating() {
        // A restart must not throw away the session that explains the
        // crash the user is restarting from.
        let dir = scratch("append");
        let mut first = sink_in(&dir, 4096, 3);
        first.write_line(b"before restart\n");
        first.flush();
        drop(first);

        let mut second = sink_in(&dir, 4096, 3);
        second.write_line(b"after restart\n");
        second.flush();

        let text = fs::read_to_string(dir.join("clippity.log")).unwrap();
        assert_eq!(text, "before restart\nafter restart\n");
    }

    #[test]
    fn clear_removes_rotated_files_and_empties_the_live_one() {
        let dir = scratch("clear");
        let mut sink = sink_in(&dir, 8, 3);
        for i in 0..3 {
            sink.write_line(format!("line-{i}\n").as_bytes());
        }
        sink.flush();
        sink.clear().unwrap();

        assert!(!dir.join("clippity.1.log").exists());
        // Truncated, not unlinked: the process is still writing here.
        assert_eq!(fs::read_to_string(dir.join("clippity.log")).unwrap(), "");
    }

    #[test]
    fn tailing_reads_from_the_end_and_never_starts_mid_line() {
        let dir = scratch("tail");
        let path = dir.join("clippity.log");
        fs::write(&path, "alpha\nbeta\ngamma\n").unwrap();
        // A window smaller than the file must snap forward to a line
        // boundary rather than returning "ta\ngamma\n".
        let text = read_tail(&path, 8).unwrap();
        assert_eq!(text, "gamma\n");
    }

    #[test]
    fn tailing_a_file_smaller_than_the_window_returns_all_of_it() {
        let dir = scratch("tail-small");
        let path = dir.join("clippity.log");
        fs::write(&path, "only\n").unwrap();
        assert_eq!(read_tail(&path, 4096).unwrap(), "only\n");
    }

    #[test]
    fn a_write_never_reports_failure_to_its_caller() {
        // The writer is on the path of every log line in the app: a full
        // disk must not surface as an error inside the code that logged.
        let mut writer = SinkWriter;
        assert_eq!(writer.write(b"x").unwrap(), 1);
        writer.flush().unwrap();
    }
}
