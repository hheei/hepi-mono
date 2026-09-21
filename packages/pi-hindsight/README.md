# @hheei/pi-hindsight

HEPI-maintained fork of [`luxus/pi-hindsight`](https://github.com/luxus/pi-hindsight), providing Hindsight-backed long-term memory for Pi.

This package owns durable memory lifecycle only:

- automatic recall before model calls;
- automatic retain after completed agent runs;
- Hindsight banks, scopes, queues, cursors, and memory tools;
- memory diagnostics and setup commands.

`@hheei/pi-mctx` owns context-window management, including historian, compartments, compaction, history injection, and transcript continuity. `pi-subagents` does not receive memory capabilities from this package.

## Upstream

The implementation is forked from upstream commit `d5c6f6e6dc309830a4dd70b6bef12f029a1c35a8`.

Upstream source and documentation remain under the MIT license. See `LICENSE` for the attribution text.
