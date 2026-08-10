//! Cancellable N-API boundary for vendored mpatch.
//!
//! `pi-ext-tools` owns patch parsing policy and staging. This module invokes the
//! private Rust library only against that staging directory. Cancellation is
//! cooperative: vendored mpatch observes one shared flag before each write and
//! throughout fuzzy scoring; `abort()` waits for its blocking task to finish.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use mpatch::{
    ApplyOptions, HunkApplyError, HunkApplyStatus, MatchType, apply_patches_to_dir, parse_auto,
};
use napi::{Env, Error, Result, bindgen_prelude::PromiseRaw};
use napi_derive::napi;
use tokio::sync::Notify;

/// Options for one staged mpatch invocation.
#[napi(object)]
pub struct MpatchRunOptions {
    pub cwd: String,
    pub unified_diff: String,
    pub fuzz_factor: f64,
    pub dry_run: bool,
}

/// mpatch completion state. Vendored library operations do not stream output.
#[napi(object)]
pub struct MpatchRunResult {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub outcomes: Vec<MpatchHunkOutcome>,
}

/// Source-free location reported by a fuzzy ambiguity.
#[napi(object)]
pub struct MpatchHunkCandidate {
    pub start_line: u32,
    pub length: u32,
}

/// Source-free best fuzzy match that did not meet its threshold.
#[napi(object)]
pub struct MpatchFuzzyBest {
    pub start_line: u32,
    pub length: u32,
    pub score: f64,
}

/// Tagged mpatch hunk result, without patch content or filesystem paths.
#[napi(object)]
pub struct MpatchHunkOutcome {
    pub kind: String,
    pub hunk_index: u32,
    pub start_line: Option<u32>,
    pub length: Option<u32>,
    pub r#match: Option<String>,
    pub score: Option<f64>,
    pub candidate_start_lines: Option<Vec<u32>>,
    pub candidates: Option<Vec<MpatchHunkCandidate>>,
    pub best: Option<MpatchFuzzyBest>,
    pub threshold: Option<f64>,
}

struct MpatchCommand {
    cwd: String,
    unified_diff: String,
    fuzz_factor: f64,
    dry_run: bool,
}

enum Lifecycle {
    Idle(MpatchCommand),
    Running,
    Finished,
}

struct RunState {
    lifecycle: Mutex<Lifecycle>,
    cancellation: Arc<AtomicBool>,
    completion: Notify,
}

impl RunState {
    fn start(&self) -> Result<MpatchCommand> {
        let mut lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| Error::from_reason("mpatch run state is poisoned"))?;
        match std::mem::replace(&mut *lifecycle, Lifecycle::Finished) {
            Lifecycle::Idle(command) => {
                *lifecycle = Lifecycle::Running;
                Ok(command)
            }
            Lifecycle::Running => {
                *lifecycle = Lifecycle::Running;
                Err(Error::from_reason("mpatch run is already active"))
            }
            Lifecycle::Finished => {
                *lifecycle = Lifecycle::Finished;
                Err(Error::from_reason("mpatch run has already completed"))
            }
        }
    }

    fn finish(&self) -> Result<()> {
        let mut lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| Error::from_reason("mpatch run state is poisoned"))?;
        *lifecycle = Lifecycle::Finished;
        drop(lifecycle);
        self.completion.notify_waiters();
        Ok(())
    }

    async fn abort(&self) -> Result<()> {
        self.cancellation.store(true, Ordering::Release);
        loop {
            let notified = self.completion.notified();
            let is_running = matches!(
                *self
                    .lifecycle
                    .lock()
                    .map_err(|_| Error::from_reason("mpatch run state is poisoned"))?,
                Lifecycle::Running
            );
            if !is_running {
                return Ok(());
            }
            notified.await;
        }
    }
}

/// Single-use staged mpatch run.
///
/// Dropping its JavaScript wrapper requests cancellation; explicit `abort()`
/// additionally waits until no blocking fuzzy search can touch staging.
#[napi]
pub struct MpatchRun {
    state: Arc<RunState>,
}

impl Drop for MpatchRun {
    fn drop(&mut self) {
        self.state.cancellation.store(true, Ordering::Release);
    }
}

#[napi]
impl MpatchRun {
    #[napi(constructor)]
    pub fn new(options: MpatchRunOptions) -> Result<Self> {
        if !options.fuzz_factor.is_finite() || !(0.0..=1.0).contains(&options.fuzz_factor) {
            return Err(Error::from_reason("invalid mpatch fuzz factor"));
        }
        Ok(Self {
            state: Arc::new(RunState {
                lifecycle: Mutex::new(Lifecycle::Idle(MpatchCommand {
                    cwd: options.cwd,
                    unified_diff: options.unified_diff,
                    fuzz_factor: options.fuzz_factor,
                    dry_run: options.dry_run,
                })),
                cancellation: Arc::new(AtomicBool::new(false)),
                completion: Notify::new(),
            }),
        })
    }

    /// Starts the one allowed mpatch invocation.
    #[napi]
    pub fn run<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, MpatchRunResult>> {
        let command = self.state.start()?;
        let state = Arc::clone(&self.state);
        let cancellation = Arc::clone(&state.cancellation);
        env.spawn_future(async move {
            let result = tokio::task::spawn_blocking(move || run(command, cancellation))
                .await
                .map_err(|error| Error::from_reason(format!("mpatch task failed: {error}")))
                .and_then(|result| result);
            state.finish()?;
            result
        })
    }

    #[napi]
    pub async fn abort(&self) -> Result<()> {
        self.state.abort().await
    }
}

fn run(command: MpatchCommand, cancellation: Arc<AtomicBool>) -> Result<MpatchRunResult> {
    if cancellation.load(Ordering::Acquire) {
        return Err(aborted_error());
    }
    let mut patches = parse_auto(&command.unified_diff)
        .map_err(|error| Error::from_reason(format!("parse mpatch input: {error}")))?;
    for patch in &mut patches {
        for hunk in &mut patch.hunks {
            hunk.old_start_line = None;
        }
    }
    if cancellation.load(Ordering::Acquire) {
        return Err(aborted_error());
    }

    let options = ApplyOptions::new()
        .with_dry_run(command.dry_run)
        .with_fuzz_factor(command.fuzz_factor as f32)
        .with_cancellation(cancellation.clone());
    let batch = apply_patches_to_dir(&patches, std::path::Path::new(&command.cwd), options);
    if cancellation.load(Ordering::Acquire) {
        return Err(aborted_error());
    }

    let stderr = batch
        .results
        .iter()
        .filter_map(|(path, result)| match result {
            Ok(result) if result.report.all_applied_cleanly() => None,
            Ok(_) => Some(format!("patch did not apply cleanly: {}", path.display())),
            Err(error) => Some(format!("patch failed for {}: {error}", path.display())),
        })
        .collect::<Vec<_>>()
        .join("\n");
    let outcomes = batch
        .results
        .iter()
        .flat_map(|(_, result)| result.as_ref().ok())
        .flat_map(|result| result.report.hunk_results.iter().enumerate())
        .filter_map(|(index, status)| mpatch_outcome(index, status))
        .collect();
    Ok(MpatchRunResult {
        status: Some(if stderr.is_empty() { 0 } else { 1 }),
        stdout: String::new(),
        stderr,
        outcomes,
    })
}

fn mpatch_outcome(index: usize, status: &HunkApplyStatus) -> Option<MpatchHunkOutcome> {
    let hunk_index = usize_to_u32(index + 1);
    let mut outcome = MpatchHunkOutcome {
        kind: String::new(),
        hunk_index,
        start_line: None,
        length: None,
        r#match: None,
        score: None,
        candidate_start_lines: None,
        candidates: None,
        best: None,
        threshold: None,
    };
    match status {
        HunkApplyStatus::Applied {
            location,
            match_type,
            ..
        } => {
            outcome.kind = "applied".to_string();
            outcome.start_line = Some(usize_to_u32(location.start_index + 1));
            outcome.length = Some(usize_to_u32(location.length));
            let (match_kind, score) = match match_type {
                MatchType::Exact => ("exact", None),
                MatchType::ExactIgnoringWhitespace => ("exact_ignoring_whitespace", None),
                MatchType::Fuzzy { score } => ("fuzzy", Some(*score)),
            };
            outcome.r#match = Some(match_kind.to_string());
            outcome.score = score;
        }
        HunkApplyStatus::Failed(HunkApplyError::ContextNotFound) => {
            outcome.kind = "context_not_found".to_string();
        }
        HunkApplyStatus::Failed(HunkApplyError::AmbiguousExactMatch(candidates)) => {
            outcome.kind = "ambiguous_exact".to_string();
            outcome.candidate_start_lines = Some(
                candidates
                    .iter()
                    .map(|&start| usize_to_u32(start + 1))
                    .collect(),
            );
        }
        HunkApplyStatus::Failed(HunkApplyError::AmbiguousFuzzyMatch(candidates)) => {
            outcome.kind = "ambiguous_fuzzy".to_string();
            outcome.candidates = Some(
                candidates
                    .iter()
                    .map(|&(start_index, length)| MpatchHunkCandidate {
                        start_line: usize_to_u32(start_index + 1),
                        length: usize_to_u32(length),
                    })
                    .collect(),
            );
        }
        HunkApplyStatus::Failed(HunkApplyError::FuzzyMatchBelowThreshold {
            best_score,
            threshold,
            location,
        }) => {
            outcome.kind = "fuzzy_below_threshold".to_string();
            outcome.best = Some(MpatchFuzzyBest {
                start_line: usize_to_u32(location.start_index + 1),
                length: usize_to_u32(location.length),
                score: *best_score,
            });
            outcome.threshold = Some(f64::from(*threshold));
        }
        HunkApplyStatus::SkippedNoChanges | HunkApplyStatus::Failed(HunkApplyError::Cancelled) => {
            return None;
        }
    }
    Some(outcome)
}

fn usize_to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn aborted_error() -> Error {
    Error::from_reason("mpatch aborted")
}
