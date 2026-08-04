//! HEPI-owned N-API boundary for selected native capabilities.

mod mpatch;
mod pty;

use napi_derive::napi;

/// Returns the bridge protocol version used by the JavaScript loader.
#[napi]
pub const fn pi_native_bridge_version() -> u32 {
    1
}
