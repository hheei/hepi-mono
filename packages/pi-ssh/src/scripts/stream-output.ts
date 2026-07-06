import type { Readable } from "node:stream";

import { type OutputSource, OutputTailSink } from "./output-tail-sink.js";

export const MAX_OUTPUT_BYTES = 50 * 1024;

export async function readProcessOutputTail(
	stdout: Readable | null | undefined,
	stderr: Readable | null | undefined,
	sensitiveValues: string[],
	maxBytes = MAX_OUTPUT_BYTES,
) {
	const sink = new OutputTailSink(maxBytes);
	await pipeStreamsToSink(stdout, stderr, sink, sensitiveValues);
	return sink.dump();
}

async function pipeStreamsToSink(
	stdout: Readable | null | undefined,
	stderr: Readable | null | undefined,
	sink: OutputTailSink,
	sensitiveValues: string[],
): Promise<void> {
	const tasks: Array<Promise<void>> = [];
	if (stdout) tasks.push(pipeReadable(stdout, "stdout", sink, sensitiveValues));
	if (stderr) tasks.push(pipeReadable(stderr, "stderr", sink, sensitiveValues));
	await Promise.all(tasks);
}

async function pipeReadable(
	stream: Readable,
	source: OutputSource,
	sink: OutputTailSink,
	sensitiveValues: string[],
): Promise<void> {
	const decoder = new TextDecoder();
	const redactor = new StreamingRedactor(sensitiveValues);

	for await (const chunk of stream) {
		const text = decoder.decode(chunk as Uint8Array, { stream: true });
		const redacted = redactor.write(text);
		if (redacted) sink.write(source, redacted);
	}

	const flushed = redactor.write(decoder.decode()) + redactor.flush();
	if (flushed) sink.write(source, flushed);
}

class StreamingRedactor {
	private readonly values: string[];
	private readonly retainChars: number;
	private pending = "";

	constructor(values: string[]) {
		this.values = Array.from(new Set(values.filter(Boolean))).sort((a, b) => b.length - a.length);
		this.retainChars = Math.max(0, ...this.values.map((value) => value.length));
	}

	write(chunk: string): string {
		if (!chunk) return "";
		const text = this.pending + chunk;
		if (this.values.length === 0) {
			this.pending = "";
			return text;
		}

		const keep = Math.min(this.retainChars, text.length);
		const safeText = text.slice(0, text.length - keep);
		this.pending = text.slice(text.length - keep);
		return this.redact(safeText);
	}

	flush(): string {
		if (!this.pending) return "";
		const flushed = this.redact(this.pending);
		this.pending = "";
		return flushed;
	}

	private redact(text: string): string {
		let redacted = text;
		for (const value of this.values) {
			redacted = redacted.split(value).join("<control-socket>");
		}
		return redacted;
	}
}
