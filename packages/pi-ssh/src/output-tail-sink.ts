export interface TailDump {
	text: string;
	stdout: string;
	stderr: string;
	truncated: boolean;
	totalBytes: number;
	outputBytes: number;
	totalLines: number;
	outputLines: number;
}

export type OutputSource = "stdout" | "stderr";

interface TailEntry {
	source: OutputSource;
	buffer: Buffer;
}

export class OutputTailSink {
	private entries: TailEntry[] = [];
	private didTruncate = false;
	private retainedBytes = 0;
	private writtenBytes = 0;
	private writtenLines = 0;

	constructor(private readonly maxBytes: number) {}

	write(chunk: Uint8Array | string): void;
	write(source: OutputSource, chunk: Uint8Array | string): void;
	write(sourceOrChunk: OutputSource | Uint8Array | string, maybeChunk?: Uint8Array | string): void {
		const source = maybeChunk === undefined ? "stdout" : (sourceOrChunk as OutputSource);
		const chunk = maybeChunk === undefined ? (sourceOrChunk as Uint8Array | string) : maybeChunk;
		const next = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
		if (next.length === 0) return;

		this.entries.push({ source, buffer: next });
		this.retainedBytes += next.length;
		this.writtenBytes += next.length;
		this.writtenLines += countNewlines(next.toString("utf8"));
		this.trim();
	}

	dump(): TailDump {
		const combined: Buffer[] = [];
		const stdoutBuffers: Buffer[] = [];
		const stderrBuffers: Buffer[] = [];

		for (const entry of this.entries) {
			combined.push(entry.buffer);
			if (entry.source === "stdout") {
				stdoutBuffers.push(entry.buffer);
			} else {
				stderrBuffers.push(entry.buffer);
			}
		}

		const text = Buffer.concat(combined).toString("utf8");
		const stdout = Buffer.concat(stdoutBuffers).toString("utf8");
		const stderr = Buffer.concat(stderrBuffers).toString("utf8");

		return {
			text,
			stdout,
			stderr,
			truncated: this.didTruncate,
			totalBytes: this.writtenBytes,
			outputBytes: this.retainedBytes,
			totalLines: this.writtenLines,
			outputLines: countNewlines(text),
		};
	}

	private trim(): void {
		if (this.retainedBytes <= this.maxBytes) return;
		this.didTruncate = true;

		const retained = Buffer.concat(this.entries.map((entry) => entry.buffer));
		const sliced = retained.subarray(findUtf8TailStart(retained, this.maxBytes));
		const rebuilt: TailEntry[] = [];
		let offset = retained.length - sliced.length;
		let retainedBytes = 0;

		for (const entry of this.entries) {
			if (offset >= entry.buffer.length) {
				offset -= entry.buffer.length;
				continue;
			}

			const buffer = offset > 0 ? entry.buffer.subarray(offset) : entry.buffer;
			offset = 0;
			rebuilt.push({ source: entry.source, buffer });
			retainedBytes += buffer.length;
		}

		this.entries =
			rebuilt.length > 0 || sliced.length === 0 ? rebuilt : [{ source: "stdout", buffer: sliced }];
		this.retainedBytes = retainedBytes;
	}
}

export async function readStreamTail(
	stream: ReadableStream<Uint8Array> | null,
	maxBytes: number,
): Promise<TailDump> {
	const sink = new OutputTailSink(maxBytes);
	if (!stream) return sink.dump();

	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) sink.write(value);
		}
	} finally {
		reader.releaseLock();
	}

	return sink.dump();
}

function countNewlines(text: string): number {
	let count = 0;
	let index = text.indexOf("\n");
	while (index !== -1) {
		count += 1;
		index = text.indexOf("\n", index + 1);
	}
	return count;
}

function findUtf8TailStart(buffer: Buffer, maxBytes: number): number {
	if (buffer.length <= maxBytes) return 0;

	let start = buffer.length - maxBytes;
	while (isUtf8ContinuationByte(buffer[start])) start += 1;
	while (start < buffer.length) {
		const byte = buffer[start];
		if (byte === undefined) break;
		const width = utf8SequenceWidth(byte);
		if (width === 0) {
			start += 1;
			continue;
		}
		if (start + width <= buffer.length) return start;
		start += 1;
		while (isUtf8ContinuationByte(buffer[start])) start += 1;
	}
	return buffer.length;
}
function isUtf8ContinuationByte(byte: number | undefined): boolean {
	return byte !== undefined && (byte & 0xc0) === 0x80;
}

function utf8SequenceWidth(byte: number): number {
	if ((byte & 0x80) === 0) return 1;
	if ((byte & 0xe0) === 0xc0) return 2;
	if ((byte & 0xf0) === 0xe0) return 3;
	if ((byte & 0xf8) === 0xf0) return 4;
	return 0;
}
