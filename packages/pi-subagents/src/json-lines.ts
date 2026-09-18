import type { Readable, Writable } from "node:stream";

export type JsonLineErrorCode = "frame_too_large" | "malformed_json" | "stream_error";

export class JsonLineError extends Error {
	public readonly code: JsonLineErrorCode;

	public constructor(code: JsonLineErrorCode, message: string) {
		super(message);
		this.name = "JsonLineError";
		this.code = code;
	}
}

export interface JsonLineReaderOptions {
	readonly maxFrameBytes: number;
	readonly onValue: (value: unknown) => void;
	readonly onError: (error: JsonLineError) => void;
}

export function attachJsonLineReader(stream: Readable, options: JsonLineReaderOptions): () => void {
	if (!Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes < 1) {
		throw new Error("maxFrameBytes must be a positive safe integer");
	}
	let buffer: Buffer = Buffer.alloc(0);
	let stopped = false;

	const fail = (error: JsonLineError): void => {
		if (stopped) return;
		stopped = true;
		cleanup();
		options.onError(error);
	};
	const onData = (chunk: Buffer | string): void => {
		if (stopped) return;
		const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		buffer = buffer.length === 0 ? incoming : Buffer.concat([buffer, incoming]);
		while (!stopped) {
			const newline = buffer.indexOf(0x0a);
			if (newline < 0) {
				if (buffer.length > options.maxFrameBytes) {
					fail(new JsonLineError("frame_too_large", "JSON line exceeds frame limit"));
				}
				return;
			}
			if (newline > options.maxFrameBytes) {
				fail(new JsonLineError("frame_too_large", "JSON line exceeds frame limit"));
				return;
			}
			let frame = buffer.subarray(0, newline);
			buffer = buffer.subarray(newline + 1);
			if (frame.length > 0 && frame[frame.length - 1] === 0x0d) {
				frame = frame.subarray(0, frame.length - 1);
			}
			if (frame.length === 0) continue;
			try {
				options.onValue(JSON.parse(frame.toString("utf8")) as unknown);
			} catch (error) {
				fail(
					new JsonLineError(
						"malformed_json",
						`Malformed JSON line: ${error instanceof Error ? error.message : String(error)}`,
					),
				);
			}
		}
	};
	const onStreamError = (error: Error): void => {
		fail(new JsonLineError("stream_error", error.message));
	};
	const cleanup = (): void => {
		stream.off("data", onData);
		stream.off("error", onStreamError);
		buffer = Buffer.alloc(0);
	};

	stream.on("data", onData);
	stream.on("error", onStreamError);
	return (): void => {
		if (stopped) return;
		stopped = true;
		cleanup();
	};
}

export function serializeJsonLine(value: unknown, maxFrameBytes: number): Buffer {
	const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
	if (encoded.length - 1 > maxFrameBytes) {
		throw new JsonLineError("frame_too_large", "Serialized JSON line exceeds frame limit");
	}
	return encoded;
}

export function writeJsonLine(
	stream: Writable,
	value: unknown,
	maxFrameBytes: number,
): Promise<void> {
	let encoded: Buffer;
	try {
		encoded = serializeJsonLine(value, maxFrameBytes);
	} catch (error) {
		return Promise.reject(error);
	}
	return new Promise((resolve, reject) => {
		stream.write(encoded, (error?: Error | null) => {
			if (error) reject(error);
			else resolve();
		});
	});
}
