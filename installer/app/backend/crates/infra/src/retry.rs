//! Bounded retry for transient Windows file-lock failures.
//!
//! A freshly written, unsigned executable is routinely held open for a beat
//! by antivirus real-time scanning, the Search Indexer, or SmartScreen. An
//! installer that deletes or rewrites that file *immediately* — an install
//! followed straight away by a repair, or an uninstall run seconds after the
//! copy — can therefore fail spuriously with `ERROR_ACCESS_DENIED` or
//! `ERROR_SHARING_VIOLATION`, even though nothing is really wrong and the
//! lock clears within a fraction of a second. Every production Windows
//! installer retries these operations; so do we.

use std::io;
use std::thread::sleep;
use std::time::Duration;

/// Whether an I/O error looks like a *transient* lock a retry can clear,
/// rather than a genuine permission problem.
///
/// Covers `ERROR_ACCESS_DENIED` (5), `ERROR_SHARING_VIOLATION` (32), and
/// `ERROR_LOCK_VIOLATION` (33) — the codes an AV/indexer hold surfaces as.
pub fn is_transient_lock(e: &io::Error) -> bool {
    matches!(e.kind(), io::ErrorKind::PermissionDenied)
        || matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33))
}

/// Run a fallible filesystem operation, retrying a transient Windows lock a
/// few times with increasing backoff before giving up.
///
/// Five attempts total, backing off 100 → 200 → 400 → 800 ms (~1.5 s worst
/// case). A non-transient error (a real permission or not-found failure) is
/// returned immediately without wasting the backoff budget. The final
/// attempt's error is surfaced as-is so callers still see the true cause
/// when a lock genuinely will not clear.
pub fn with_retry<T>(mut op: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let mut delay = Duration::from_millis(100);
    for _ in 0..4 {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) if is_transient_lock(&e) => {
                tracing::warn!(error = %e, backoff_ms = delay.as_millis(), "transient file lock — retrying");
                sleep(delay);
                delay *= 2;
            }
            Err(e) => return Err(e),
        }
    }
    op()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn succeeds_after_a_few_transient_failures() {
        let attempts = Cell::new(0);
        let out = with_retry(|| {
            let n = attempts.get() + 1;
            attempts.set(n);
            if n < 3 {
                Err(io::Error::from_raw_os_error(5)) // access denied
            } else {
                Ok(n)
            }
        });
        assert_eq!(out.unwrap(), 3);
        assert_eq!(attempts.get(), 3);
    }

    #[test]
    fn a_non_transient_error_is_returned_immediately() {
        let attempts = Cell::new(0);
        let out: io::Result<()> = with_retry(|| {
            attempts.set(attempts.get() + 1);
            Err(io::Error::new(io::ErrorKind::NotFound, "gone"))
        });
        assert!(out.is_err());
        assert_eq!(attempts.get(), 1, "a non-transient error must not be retried");
    }

    #[test]
    fn gives_up_after_the_attempt_budget() {
        let attempts = Cell::new(0);
        let out: io::Result<()> = with_retry(|| {
            attempts.set(attempts.get() + 1);
            Err(io::Error::from_raw_os_error(32)) // sharing violation
        });
        assert!(out.is_err());
        assert_eq!(attempts.get(), 5, "four backoffs then a final attempt = five tries");
    }
}
