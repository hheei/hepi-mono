# Logging Guidelines

## Overview

`pi-ssh` does not use console logging for tool execution. Command output is returned as bounded tool content and structured details.

## Output Capture

- Capture stdout and stderr through `readProcessOutputTail()`.
- Retain only bounded tail output and include truncation metadata.
- Preserve stdout/stderr ordering in combined output where supported.
- Sanitize sensitive values before returning output, stdout, stderr, or notices.

## User Feedback

- Tool result text should include command output and notices such as timeout or non-zero exit status.
- Collapsed render output should show a tail preview and mention skipped earlier lines.

## Forbidden Patterns

- Do not stream unbounded remote output into tool results.
- Do not write remote command output to local logs by default.
- Do not include raw sensitive SSH args in returned details.

## Examples

- `packages/pi-ssh/src/stream-output.ts`
- `packages/pi-ssh/src/output-tail-sink.ts`
- `packages/pi-ssh/src/index.ts#renderCollapsedResult`
