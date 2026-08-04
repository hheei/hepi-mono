//! Session-owned pseudo-terminal boundary.
//!
//! The JavaScript owner is responsible for UI and output retention. This module
//! owns exactly one native child, reader, writer and terminal size; `close` and
//! wrapper drop only terminate that child and never affect Pi host Bash.

use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use napi::{
    Env, Error, Result,
    bindgen_prelude::{Buffer, PromiseRaw},
};
use napi_derive::napi;
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

/// Native process and terminal settings supplied by the extension-owned caller.
#[napi(object)]
pub struct PtySessionOptions {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Option<HashMap<String, String>>,
    pub rows: u32,
    pub cols: u32,
}

/// One blocking read result. `eof` means the slave side has closed.
#[napi(object)]
pub struct PtyReadResult {
    pub output: String,
    pub eof: bool,
}

/// Child result after `wait()` reaps this session's process.
#[napi(object)]
pub struct PtyExitStatus {
    pub code: u32,
    pub signal: Option<String>,
}

struct PtySessionState {
    master: Mutex<Box<dyn MasterPty + Send>>,
    reader: Mutex<Box<dyn Read + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    closed: AtomicBool,
}

impl PtySessionState {
    fn close(&self) -> Result<()> {
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        // A child can exit normally before teardown. Its process handle is then
        // already gone; close remains idempotent rather than surfacing ESRCH.
        let mut killer = self
            .killer
            .lock()
            .map_err(|_| Error::from_reason("pty killer state is poisoned"))?;
        let _ = killer.kill();
        Ok(())
    }
}

/// One extension-owned pseudo-terminal. Reads execute away from N-API's main
/// thread; callers must serialize `read()` calls and close/reap on teardown.
#[napi]
pub struct PtySession {
    state: Arc<PtySessionState>,
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let _ = self.state.close();
    }
}

#[napi]
impl PtySession {
    #[napi(constructor)]
    pub fn new(options: PtySessionOptions) -> Result<Self> {
        if options.command.trim().is_empty() {
            return Err(Error::from_reason("pty command must not be empty"));
        }
        if options.cwd.trim().is_empty() {
            return Err(Error::from_reason("pty cwd must not be empty"));
        }
        let size = pty_size(options.rows, options.cols)?;
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size)
            .map_err(|error| Error::from_reason(format!("open pty: {error}")))?;
        let mut command = CommandBuilder::new(&options.command);
        command.args(&options.args);
        command.cwd(&options.cwd);
        for (key, value) in options.env.unwrap_or_default() {
            command.env(key, value);
        }
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| Error::from_reason(format!("spawn pty command: {error}")))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| Error::from_reason(format!("clone pty reader: {error}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| Error::from_reason(format!("take pty writer: {error}")))?;
        let killer = child.clone_killer();
        Ok(Self {
            state: Arc::new(PtySessionState {
                master: Mutex::new(pair.master),
                reader: Mutex::new(reader),
                writer: Mutex::new(writer),
                killer: Mutex::new(killer),
                child: Mutex::new(Some(child)),
                closed: AtomicBool::new(false),
            }),
        })
    }

    /// Blocks until output or EOF, without blocking Node's main thread.
    #[napi]
    pub fn read<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, PtyReadResult>> {
        let state = Arc::clone(&self.state);
        env.spawn_future(async move {
            tokio::task::spawn_blocking(move || read_once(&state))
                .await
                .map_err(|error| Error::from_reason(format!("pty reader task failed: {error}")))?
        })
    }

    #[napi]
    pub fn write(&self, data: Buffer) -> Result<()> {
        if self.state.closed.load(Ordering::Acquire) {
            return Err(Error::from_reason("pty session is closed"));
        }
        let mut writer = self
            .state
            .writer
            .lock()
            .map_err(|_| Error::from_reason("pty writer state is poisoned"))?;
        writer
            .write_all(data.as_ref())
            .and_then(|()| writer.flush())
            .map_err(|error| Error::from_reason(format!("write pty input: {error}")))
    }

    #[napi]
    pub fn resize(&self, rows: u32, cols: u32) -> Result<()> {
        if self.state.closed.load(Ordering::Acquire) {
            return Err(Error::from_reason("pty session is closed"));
        }
        let master = self
            .state
            .master
            .lock()
            .map_err(|_| Error::from_reason("pty master state is poisoned"))?;
        master
            .resize(pty_size(rows, cols)?)
            .map_err(|error| Error::from_reason(format!("resize pty: {error}")))
    }

    /// Sends the platform PTY termination signal. Calling this more than once is safe.
    #[napi]
    pub fn close(&self) -> Result<()> {
        self.state.close()
    }

    /// Reaps the child once it exits. `close()` remains available while waiting.
    #[napi]
    pub fn wait<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, PtyExitStatus>> {
        let state = Arc::clone(&self.state);
        env.spawn_future(async move {
            tokio::task::spawn_blocking(move || wait_for_child(&state))
                .await
                .map_err(|error| Error::from_reason(format!("pty wait task failed: {error}")))?
        })
    }
}

fn pty_size(rows: u32, cols: u32) -> Result<PtySize> {
    let rows = u16::try_from(rows).map_err(|_| Error::from_reason("pty rows exceed u16"))?;
    let cols = u16::try_from(cols).map_err(|_| Error::from_reason("pty cols exceed u16"))?;
    if rows == 0 || cols == 0 {
        return Err(Error::from_reason("pty rows and cols must be positive"));
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn read_once(state: &PtySessionState) -> Result<PtyReadResult> {
    let mut reader = state
        .reader
        .lock()
        .map_err(|_| Error::from_reason("pty reader state is poisoned"))?;
    let mut bytes = [0_u8; 8192];
    let count = reader
        .read(&mut bytes)
        .map_err(|error| Error::from_reason(format!("read pty output: {error}")))?;
    Ok(PtyReadResult {
        output: String::from_utf8_lossy(&bytes[..count]).into_owned(),
        eof: count == 0,
    })
}

fn wait_for_child(state: &PtySessionState) -> Result<PtyExitStatus> {
    let mut child = state
        .child
        .lock()
        .map_err(|_| Error::from_reason("pty child state is poisoned"))?
        .take()
        .ok_or_else(|| Error::from_reason("pty child has already been reaped"))?;
    let status = child
        .wait()
        .map_err(|error| Error::from_reason(format!("wait for pty child: {error}")))?;
    Ok(PtyExitStatus {
        code: status.exit_code(),
        signal: status.signal().map(str::to_owned),
    })
}
