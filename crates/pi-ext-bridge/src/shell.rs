//! Session-scoped Brush shell N-API boundary.
//!
//! `pi-shell` owns shell parsing, command execution, builtin registration and
//! uutils context. This module only owns N-API type conversion, JavaScript
//! cancellation, and bounded delivery of streamed output.

use std::{collections::HashMap, sync::Arc};

use napi::{
    Env, Error, Result,
    bindgen_prelude::*,
    threadsafe_function::{ThreadsafeFunction, UnknownReturnValue},
};
use napi_derive::napi;
use pi_shell::{
    Shell as CoreShell, ShellOptions as CoreShellOptions, ShellRunOptions as CoreShellRunOptions,
    ShellRunResult as CoreShellRunResult,
    cancel::{AbortReason, CancelToken},
};

/// Options applied when creating a persistent shell session.
#[napi(object)]
pub struct ShellOptions {
    /// Environment variables retained by this session.
    pub session_env: Option<HashMap<String, String>>,
    /// Optional shell snapshot sourced when the session starts.
    pub snapshot_path: Option<String>,
}

impl From<ShellOptions> for CoreShellOptions {
    fn from(value: ShellOptions) -> Self {
        Self {
            session_env: value.session_env,
            snapshot_path: value.snapshot_path,
            minimizer: None,
        }
    }
}

/// Options for one command in a persistent shell session.
#[napi(object)]
pub struct ShellRunOptions<'env> {
    /// Bash-style command text executed by Brush.
    pub command: String,
    /// Working directory for this command.
    pub cwd: Option<String>,
    /// Environment variables applied to this command only.
    pub env: Option<HashMap<String, String>>,
    /// Maximum execution time before the command is cancelled.
    pub timeout_ms: Option<u32>,
    /// JavaScript AbortSignal for cancelling the command.
    pub signal: Option<Unknown<'env>>,
}

/// Completion state for one shell command.
#[napi(object)]
pub struct ShellRunResult {
    /// Exit code when the command completed normally.
    pub exit_code: Option<i32>,
    /// Whether cancellation interrupted the command.
    pub cancelled: bool,
    /// Whether the configured timeout caused cancellation.
    pub timed_out: bool,
    /// Shell working directory after command completion.
    pub working_dir: Option<String>,
}

impl From<CoreShellRunResult> for ShellRunResult {
    fn from(value: CoreShellRunResult) -> Self {
        Self {
            exit_code: value.exit_code,
            cancelled: value.cancelled,
            timed_out: value.timed_out,
            working_dir: value.working_dir,
        }
    }
}

/// Persistent, session-scoped Brush shell.
///
/// A handle retains shell cwd, exported environment and background jobs. Pi
/// session owners must call [`Self::abort`] during disposal.
#[napi]
pub struct Shell {
    inner: Arc<CoreShell>,
}

#[napi]
impl Shell {
    /// Creates a session without exposing upstream Rust options to JavaScript.
    #[napi(constructor)]
    pub fn new(options: Option<ShellOptions>) -> Self {
        Self {
            inner: Arc::new(CoreShell::new(options.map(Into::into))),
        }
    }

    /// Runs one command and forwards ordered stdout/stderr chunks to JavaScript.
    #[napi]
    pub fn run<'env>(
        &self,
        env: &'env Env,
        options: ShellRunOptions<'env>,
        #[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
        on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
    ) -> Result<PromiseRaw<'env, ShellRunResult>> {
        let cancel_token = cancellation_token(options.timeout_ms, options.signal)?;
        let run_options = CoreShellRunOptions {
            command: options.command,
            cwd: options.cwd,
            env: options.env,
            timeout_ms: options.timeout_ms,
        };
        let inner = Arc::clone(&self.inner);
        env.spawn_future(async move {
            let (chunk_tx, drain_handle) = bridge_chunks(on_chunk);
            let result = inner
                .run(run_options, chunk_tx, cancel_token)
                .await
                .map(Into::into)
                .map_err(|error| Error::from_reason(error.to_string()));
            if let Some(handle) = drain_handle {
                let _ = handle.await;
            }
            result
        })
    }

    /// Cancels every active command in this shell session.
    #[napi]
    pub async fn abort(&self) -> Result<()> {
        self.inner.abort().await;
        Ok(())
    }

    /// Counts unreaped background jobs retained by this session.
    #[napi]
    pub async fn live_background_job_count(&self) -> u32 {
        self.inner.live_background_job_count().await
    }
}

fn cancellation_token(timeout_ms: Option<u32>, signal: Option<Unknown<'_>>) -> Result<CancelToken> {
    let mut token = CancelToken::new(timeout_ms);
    if let Some(signal) = signal {
        let signal = AbortSignal::from_unknown(signal)
            .map_err(|_| Error::from_reason("shell signal must be an AbortSignal"))?;
        let abort_token = token.emplace_abort_token();
        signal.on_abort(move || abort_token.abort(AbortReason::Signal));
    }
    Ok(token)
}

/// Maximum queued Rust-to-JavaScript output before pipe backpressure applies.
const BRIDGE_QUEUE_CHUNKS: usize = 64;
const MAX_BATCH_BYTES: usize = 64 * 1024;
const INITIAL_BATCH_CAPACITY: usize = 8 * 1024;

fn bridge_chunks(
    on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
) -> (
    Option<flume::Sender<String>>,
    Option<napi::tokio::task::JoinHandle<()>>,
) {
    let Some(on_chunk) = on_chunk else {
        return (None, None);
    };
    let (sender, receiver) = flume::bounded(BRIDGE_QUEUE_CHUNKS);
    let handle = napi::tokio::spawn(pump_chunks(receiver, on_chunk));
    (Some(sender), Some(handle))
}

/// Coalesces output before awaiting JavaScript consumption to bound memory.
async fn pump_chunks(
    receiver: flume::Receiver<String>,
    on_chunk: ThreadsafeFunction<String, UnknownReturnValue>,
) {
    let mut batch = String::with_capacity(INITIAL_BATCH_CAPACITY);
    while let Ok(first) = receiver.recv_async().await {
        batch.push_str(&first);
        while batch.len() < MAX_BATCH_BYTES {
            match receiver.try_recv() {
                Ok(chunk) => batch.push_str(&chunk),
                Err(_) => break,
            }
        }
        let payload = std::mem::replace(&mut batch, String::with_capacity(INITIAL_BATCH_CAPACITY));
        if on_chunk.call_async(Ok(payload)).await.is_err() {
            return;
        }
    }
}
