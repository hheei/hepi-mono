//! Cancellable N-API mpatch process boundary.
//!
//! `pi-ext-tools` owns patch parsing and policy. This module owns only one
//! package-selected executable invocation, including process lifetime and its
//! bounded output capture.

use std::{
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use napi::{Env, Error, Result, bindgen_prelude::PromiseRaw};
use napi_derive::napi;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, ChildStderr, ChildStdout},
    sync::Notify,
};
use tokio_util::sync::CancellationToken;

const MAX_MPATCH_OUTPUT_BYTES: usize = 1024 * 1024;
const OUTPUT_READ_BUFFER_BYTES: usize = 8 * 1024;

/// Options for one package-owned mpatch invocation.
#[napi(object)]
pub struct MpatchRunOptions {
    pub executable_path: String,
    pub cwd: String,
    pub unified_diff: String,
    pub fuzz_factor: f64,
    pub dry_run: bool,
}

/// Captured mpatch process completion state.
#[napi(object)]
pub struct MpatchRunResult {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

struct MpatchCommand {
    executable_path: String,
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
    cancellation: CancellationToken,
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
        self.cancellation.cancel();
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

/// Single-use package-owned mpatch process.
///
/// `abort()` resolves only after a running child has been killed and reaped.
#[napi]
pub struct MpatchRun {
    state: Arc<RunState>,
}

#[napi]
impl MpatchRun {
    #[napi(constructor)]
    pub fn new(options: MpatchRunOptions) -> Result<Self> {
        if !options.fuzz_factor.is_finite() || !(0.0..=1.0).contains(&options.fuzz_factor) {
            return Err(Error::from_reason("invalid mpatch fuzz factor"));
        }
        let command = MpatchCommand {
            executable_path: options.executable_path,
            cwd: options.cwd,
            unified_diff: options.unified_diff,
            fuzz_factor: options.fuzz_factor,
            dry_run: options.dry_run,
        };
        Ok(Self {
            state: Arc::new(RunState {
                lifecycle: Mutex::new(Lifecycle::Idle(command)),
                cancellation: CancellationToken::new(),
                completion: Notify::new(),
            }),
        })
    }

    /// Starts the one allowed mpatch invocation.
    #[napi]
    pub fn run<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, MpatchRunResult>> {
        let command = self.state.start()?;
        let state = Arc::clone(&self.state);
        let cancellation = state.cancellation.clone();
        env.spawn_future(async move {
            let result = run(command, cancellation).await;
            state.finish()?;
            result
        })
    }

    #[napi]
    pub async fn abort(&self) -> Result<()> {
        self.state.abort().await
    }
}

async fn run(options: MpatchCommand, cancellation: CancellationToken) -> Result<MpatchRunResult> {
    let temporary_directory = tempfile::tempdir()
        .map_err(|error| Error::from_reason(format!("create mpatch temp directory: {error}")))?;
    let patch_path = temporary_directory.path().join("patch.diff");
    tokio::select! {
        _ = cancellation.cancelled() => return Err(aborted_error()),
        result = tokio::fs::write(&patch_path, options.unified_diff.as_bytes()) => {
            result.map_err(|error| Error::from_reason(format!("write mpatch input: {error}")))?;
        }
    }

    let mut command = tokio::process::Command::new(&options.executable_path);
    if options.dry_run {
        command.arg("--dry-run");
    }
    let mut child = command
        .arg("--fuzz-factor")
        .arg(options.fuzz_factor.to_string())
        .arg(&patch_path)
        .arg(&options.cwd)
        .current_dir(&options.cwd)
        .env("RAYON_NUM_THREADS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Fallback if the N-API future is dropped unexpectedly. Normal
        // cancellation still calls `reap_child` so the child is waited for.
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| Error::from_reason(format!("run mpatch: {error}")))?;
    let Some(stdout) = child.stdout.take() else {
        reap_child(&mut child).await;
        return Err(Error::from_reason("mpatch stdout pipe is unavailable"));
    };
    let Some(stderr) = child.stderr.take() else {
        reap_child(&mut child).await;
        return Err(Error::from_reason("mpatch stderr pipe is unavailable"));
    };
    let captured_bytes = Arc::new(AtomicUsize::new(0));

    let output = {
        let collection = collect_output(&mut child, stdout, stderr, captured_bytes);
        tokio::pin!(collection);
        tokio::select! {
            _ = cancellation.cancelled() => None,
            result = &mut collection => Some(result),
        }
    };

    match output {
        Some(Ok(result)) => Ok(result),
        Some(Err(error)) => {
            reap_child(&mut child).await;
            Err(error)
        }
        None => {
            reap_child(&mut child).await;
            Err(aborted_error())
        }
    }
}

async fn collect_output(
    child: &mut Child,
    stdout: ChildStdout,
    stderr: ChildStderr,
    captured_bytes: Arc<AtomicUsize>,
) -> Result<MpatchRunResult> {
    let wait = async {
        child
            .wait()
            .await
            .map_err(|error| Error::from_reason(format!("wait for mpatch: {error}")))
    };
    let read = async {
        tokio::try_join!(
            read_limited(stdout, Arc::clone(&captured_bytes)),
            read_limited(stderr, captured_bytes),
        )
    };
    let (status, (stdout, stderr)) = tokio::try_join!(wait, read)?;
    Ok(MpatchRunResult {
        status: status.code(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

async fn read_limited<R>(mut reader: R, captured_bytes: Arc<AtomicUsize>) -> Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::with_capacity(OUTPUT_READ_BUFFER_BYTES);
    let mut buffer = [0_u8; OUTPUT_READ_BUFFER_BYTES];
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|error| Error::from_reason(format!("read mpatch output: {error}")))?;
        if count == 0 {
            return Ok(output);
        }
        let previous = captured_bytes.fetch_add(count, Ordering::Relaxed);
        if previous.saturating_add(count) > MAX_MPATCH_OUTPUT_BYTES {
            return Err(Error::from_reason("mpatch output exceeded 1 MiB"));
        }
        output.extend_from_slice(&buffer[..count]);
    }
}

async fn reap_child(child: &mut Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

fn aborted_error() -> Error {
    Error::from_reason("mpatch aborted")
}
