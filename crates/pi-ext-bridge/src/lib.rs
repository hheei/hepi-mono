//! HEPI-owned N-API boundary for selected vendored oh-my-pi native modules.
//!
//! The vendored crate remains the implementation owner. This crate owns the
//! JavaScript-facing contract so upstream updates do not silently become the
//! public API of this mono.

mod shell;

use napi_derive::napi;

const MAX_MPATCH_OUTPUT_BYTES: usize = 1024 * 1024;

#[napi(object)]
pub struct MpatchRunOptions {
    pub executable_path: String,
    pub cwd: String,
    pub unified_diff: String,
    pub fuzz_factor: f64,
    pub dry_run: bool,
}

#[napi(object)]
pub struct MpatchRunResult {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Returns the bridge protocol version used by the JavaScript loader.
#[napi]
pub const fn pi_native_bridge_version() -> u32 {
    1
}

/// Invokes the package-owned mpatch executable without embedding its source.
///
/// Policy, V4A parsing, workspace validation and staging remain owned by
/// pi-ext-tools. The bridge only owns subprocess I/O and the native boundary.
#[napi]
pub async fn run_mpatch(options: MpatchRunOptions) -> napi::Result<MpatchRunResult> {
    if !options.fuzz_factor.is_finite() || !(0.0..=1.0).contains(&options.fuzz_factor) {
        return Err(napi::Error::from_reason("invalid mpatch fuzz factor"));
    }

    let temporary_directory = tempfile::tempdir().map_err(|error| {
        napi::Error::from_reason(format!("create mpatch temp directory: {error}"))
    })?;
    let patch_path = temporary_directory.path().join("patch.diff");
    tokio::fs::write(&patch_path, options.unified_diff.as_bytes())
        .await
        .map_err(|error| napi::Error::from_reason(format!("write mpatch input: {error}")))?;

    let mut command = tokio::process::Command::new(&options.executable_path);
    if options.dry_run {
        command.arg("--dry-run");
    }
    let output = command
        .arg("--fuzz-factor")
        .arg(options.fuzz_factor.to_string())
        .arg(&patch_path)
        .arg(&options.cwd)
        .current_dir(&options.cwd)
        .env("RAYON_NUM_THREADS", "1")
        .output()
        .await
        .map_err(|error| napi::Error::from_reason(format!("run mpatch: {error}")))?;

    let output_size = output.stdout.len().saturating_add(output.stderr.len());
    if output_size > MAX_MPATCH_OUTPUT_BYTES {
        return Err(napi::Error::from_reason("mpatch output exceeded 1 MiB"));
    }

    Ok(MpatchRunResult {
        status: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}
