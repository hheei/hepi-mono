# @hheei/pi-native-tools

This package exposes the HEPI-owned N-API bridge for selected vendored
oh-my-pi primitives. The current surface contains `runMpatch` and the bridge
version sentinel.

The native module is built from the repository root with nightly Rust because
the pinned upstream `pi-natives` crate currently uses `alloc_error_hook`.
