//! HEPI-owned N-API boundary for selected vendored oh-my-pi native modules.
//!
//! The vendored crate remains the implementation owner. This crate owns the
//! JavaScript-facing contract so upstream updates do not silently become the
//! public API of this mono.

mod mpatch;
mod shell;

use napi_derive::napi;

/// Returns the bridge protocol version used by the JavaScript loader.
#[napi]
pub const fn pi_native_bridge_version() -> u32 {
    1
}
