//! A worker pool for splitting one frame across cores.
//!
//! # Why not `std::thread::scope`
//!
//! Scoped threads are the obvious way to fan a frame's rows out over
//! cores, and they are what the NV12 converter used first. They are also
//! wrong for this shape of work: `scope` *creates* its threads on entry
//! and *joins* them on exit, so the cost is paid again on every call —
//! and this is called sixty times a second for the length of a
//! recording. Seven threads spawned and torn down per frame at 60 fps is
//! twenty-five thousand thread creations a minute, each of which is a
//! kernel transition and a fresh stack commit.
//!
//! Worse than the mean cost is its variance. Thread creation contends
//! with whatever the user is recording — which is generally the busiest
//! thing on the machine, because it is what they thought worth
//! recording — so the stall lands exactly when the frame budget is
//! already tight, and a recording that is nearly keeping up starts
//! dropping frames rather than degrading smoothly.
//!
//! This keeps the threads. They are spawned on first use (an app that
//! never records never pays for them) and live for the process, parked
//! on a condvar between frames.
//!
//! # Borrowing still works
//!
//! [`BandPool::run`] is a scope in the sense that matters: it does not
//! return until every job has finished, so a job may borrow from the
//! caller's stack. That is what the lifetime erasure inside is for, and
//! the wait is what makes it sound — see the safety note on `run`.

use std::collections::VecDeque;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

/// Most workers the shared pool will start.
///
/// Past a point this work is bounded by memory bandwidth rather than by
/// cores, and the recorder shares the machine with whatever is being
/// recorded — taking every core would slow down the thing the user is
/// trying to capture.
const MAX_WORKERS: usize = 8;

/// A unit of work handed to a worker, with its lifetime erased. See
/// [`BandPool::run`] for why that is sound.
type Job = Box<dyn FnOnce() + Send + 'static>;

/// Shared state between the pool handle and its workers.
struct Shared {
    queue: Mutex<VecDeque<Job>>,
    /// Signalled when a job is pushed.
    ready: Condvar,
}

/// Tracks one `run` call's outstanding jobs.
struct Batch {
    remaining: AtomicUsize,
    /// Set when any job panicked, so the caller can re-raise rather than
    /// carry on over a half-written buffer.
    panicked: AtomicBool,
    done: Mutex<()>,
    /// Signalled by the job that takes `remaining` to zero.
    finished: Condvar,
}

impl Batch {
    fn settle(&self) {
        if self.remaining.fetch_sub(1, Ordering::AcqRel) == 1 {
            // The lock is taken (and immediately dropped) rather than
            // signalled bare: without it the waiter can test `remaining`,
            // find it non-zero, and be pre-empted before it waits — after
            // which this notify goes to nobody and the wait never wakes.
            drop(self.done.lock().unwrap_or_else(|e| e.into_inner()));
            self.finished.notify_all();
        }
    }
}

/// A fixed set of worker threads, shared for the process.
pub struct BandPool {
    shared: Arc<Shared>,
    workers: usize,
}

impl BandPool {
    /// The process-wide pool, started on first use.
    pub fn shared() -> &'static BandPool {
        static POOL: OnceLock<BandPool> = OnceLock::new();
        POOL.get_or_init(|| BandPool::with_workers(default_workers()))
    }

    /// How many jobs can genuinely run at once, counting the calling
    /// thread — which [`Self::run`] puts to work rather than parking.
    ///
    /// The number a caller should split its work into.
    pub fn parallelism(&self) -> usize {
        self.workers + 1
    }

    fn with_workers(workers: usize) -> Self {
        let shared = Arc::new(Shared {
            queue: Mutex::new(VecDeque::new()),
            ready: Condvar::new(),
        });
        for index in 0..workers {
            let theirs = Arc::clone(&shared);
            // Named so a profiler or a crash dump says which threads
            // these are, rather than showing eight anonymous ones.
            let spawned = std::thread::Builder::new()
                .name(format!("clippity-band-{index}"))
                .spawn(move || worker_loop(&theirs));
            if let Err(e) = spawned {
                // Fewer workers than asked for is a slower conversion,
                // not a broken one — `run` always has the calling thread.
                tracing::warn!("frame worker {index} not started: {e}");
                return Self {
                    shared,
                    workers: index,
                };
            }
        }
        Self { shared, workers }
    }

    /// Run every job, returning once they have all finished.
    ///
    /// The calling thread takes the last job itself instead of parking
    /// on it: a caller that split its work into `parallelism()` pieces
    /// would otherwise sit idle while one fewer core than it has does
    /// the work.
    ///
    /// # Panics
    ///
    /// Re-raises on the calling thread if any job panicked, once all of
    /// them have finished — matching `std::thread::scope`. A caller
    /// whose buffer is half-written must not be allowed to treat it as
    /// converted.
    pub fn run<'a>(&self, jobs: Vec<Box<dyn FnOnce() + Send + 'a>>) {
        let mut jobs = jobs;
        // The trivial cases need no queue, no batch and no signalling.
        // A pool that started no workers — a single-core machine, or one
        // where every spawn failed — is one of them, and must be: there
        // would be nobody to take a queued job, so enqueueing one would
        // block this thread forever.
        if jobs.len() <= 1 || self.workers == 0 {
            for job in jobs {
                job();
            }
            return;
        }

        // Kept for this thread, so the caller is a worker too.
        let mine = jobs.pop().expect("length checked above");

        let batch = Arc::new(Batch {
            remaining: AtomicUsize::new(jobs.len()),
            panicked: AtomicBool::new(false),
            done: Mutex::new(()),
            finished: Condvar::new(),
        });

        {
            let mut queue = self.shared.queue.lock().unwrap_or_else(|e| e.into_inner());
            for job in jobs {
                let batch = Arc::clone(&batch);
                // SAFETY: the lifetime erasure below is sound because
                // this function does not return until `remaining` has
                // reached zero, which happens only after every job has
                // run to completion (or unwound — `settle` is reached on
                // both paths). No erased job can therefore outlive the
                // `'a` data it borrows.
                //
                // The queue holds only jobs from batches currently being
                // waited on: a worker that takes one runs it immediately
                // and the pool is never drained or cleared elsewhere, so
                // there is no path by which a job outlives its `run`.
                let scoped: Box<dyn FnOnce() + Send + 'a> = Box::new(move || {
                    let outcome = std::panic::catch_unwind(AssertUnwindSafe(job));
                    if outcome.is_err() {
                        batch.panicked.store(true, Ordering::Relaxed);
                    }
                    batch.settle();
                });
                let erased: Job = unsafe { std::mem::transmute(scoped) };
                queue.push_back(erased);
            }
        }
        self.shared.ready.notify_all();

        // The caller's share, while the workers chew through theirs.
        let mine = std::panic::catch_unwind(AssertUnwindSafe(mine));

        let mut guard = batch.done.lock().unwrap_or_else(|e| e.into_inner());
        while batch.remaining.load(Ordering::Acquire) > 0 {
            guard = batch
                .finished
                .wait(guard)
                .unwrap_or_else(|e| e.into_inner());
        }
        drop(guard);

        // The caller's own panic first — it is the one with a useful
        // payload, and re-raising it preserves the message.
        if let Err(payload) = mine {
            std::panic::resume_unwind(payload);
        }
        if batch.panicked.load(Ordering::Relaxed) {
            panic!("a frame-conversion worker panicked");
        }
    }
}

/// Take jobs forever. Workers are never asked to stop: the pool is
/// process-wide and outlives every caller, so a shutdown path would only
/// add a way for a frame to be dropped on the way out.
fn worker_loop(shared: &Shared) {
    loop {
        let job = {
            let mut queue = shared.queue.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if let Some(job) = queue.pop_front() {
                    break job;
                }
                queue = shared.ready.wait(queue).unwrap_or_else(|e| e.into_inner());
            }
        };
        job();
    }
}

/// Workers to start, counting the calling thread as one of the cores.
fn default_workers() -> usize {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(MAX_WORKERS);
    // One fewer thread than cores used: `run` works the caller too.
    cores.saturating_sub(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    #[test]
    fn every_job_runs_exactly_once() {
        let counter = AtomicU32::new(0);
        let jobs: Vec<Box<dyn FnOnce() + Send>> = (0..64)
            .map(|_| {
                let counter = &counter;
                Box::new(move || {
                    counter.fetch_add(1, Ordering::Relaxed);
                }) as Box<dyn FnOnce() + Send>
            })
            .collect();
        BandPool::shared().run(jobs);
        assert_eq!(counter.load(Ordering::Relaxed), 64);
    }

    #[test]
    fn jobs_may_borrow_disjoint_pieces_of_the_callers_stack() {
        // The property the whole design rests on: `run` is a scope, so a
        // job can write into a slice living on the caller's frame.
        let mut buffer = vec![0u8; 4_096];
        {
            let jobs: Vec<Box<dyn FnOnce() + Send>> = buffer
                .chunks_mut(64)
                .enumerate()
                .map(|(i, band)| Box::new(move || band.fill(i as u8)) as Box<dyn FnOnce() + Send>)
                .collect();
            BandPool::shared().run(jobs);
        }
        for (i, band) in buffer.chunks(64).enumerate() {
            assert!(band.iter().all(|&b| b == i as u8), "band {i} not written");
        }
    }

    #[test]
    fn an_empty_batch_is_a_no_op() {
        BandPool::shared().run(Vec::new());
    }

    #[test]
    fn a_single_job_runs_on_the_calling_thread() {
        let here = std::thread::current().id();
        let seen = Mutex::new(None);
        BandPool::shared().run(vec![Box::new(|| {
            *seen.lock().unwrap() = Some(std::thread::current().id());
        })]);
        assert_eq!(*seen.lock().unwrap(), Some(here));
    }

    #[test]
    fn repeated_batches_reuse_the_same_threads() {
        // The point of the pool. Ten batches must not produce ten sets
        // of thread ids — if they do, the threads are being respawned
        // and this is `thread::scope` with extra steps.
        let ids: Mutex<std::collections::HashSet<std::thread::ThreadId>> =
            Mutex::new(Default::default());
        for _ in 0..10 {
            let jobs: Vec<Box<dyn FnOnce() + Send>> = (0..4)
                .map(|_| {
                    let ids = &ids;
                    Box::new(move || {
                        ids.lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(std::thread::current().id());
                    }) as Box<dyn FnOnce() + Send>
                })
                .collect();
            BandPool::shared().run(jobs);
        }
        let distinct = ids.lock().unwrap().len();
        assert!(
            distinct <= BandPool::shared().parallelism(),
            "{distinct} distinct threads for a pool of {}",
            BandPool::shared().parallelism()
        );
    }

    #[test]
    fn a_panicking_job_still_releases_the_batch() {
        // The deadlock this guards: a job that unwinds past its
        // decrement leaves `remaining` above zero forever, and every
        // later frame blocks behind it.
        let ran = AtomicU32::new(0);
        let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let jobs: Vec<Box<dyn FnOnce() + Send>> = (0..8)
                .map(|i| {
                    let ran = &ran;
                    Box::new(move || {
                        ran.fetch_add(1, Ordering::Relaxed);
                        assert!(i != 3, "job 3 fails on purpose");
                    }) as Box<dyn FnOnce() + Send>
                })
                .collect();
            BandPool::shared().run(jobs);
        }));
        assert!(outcome.is_err(), "the panic must reach the caller");
        assert_eq!(ran.load(Ordering::Relaxed), 8, "every job still ran");

        // …and the pool is still usable afterwards.
        let after = AtomicU32::new(0);
        let jobs: Vec<Box<dyn FnOnce() + Send>> = (0..4)
            .map(|_| {
                let after = &after;
                Box::new(move || {
                    after.fetch_add(1, Ordering::Relaxed);
                }) as Box<dyn FnOnce() + Send>
            })
            .collect();
        BandPool::shared().run(jobs);
        assert_eq!(after.load(Ordering::Relaxed), 4);
    }

    #[test]
    fn parallelism_counts_the_caller() {
        assert!(BandPool::shared().parallelism() >= 1);
        assert!(BandPool::shared().parallelism() <= MAX_WORKERS);
    }
}
