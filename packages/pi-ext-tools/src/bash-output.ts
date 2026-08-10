import type { OutputRegistry, OutputUri } from "@hheei/pi-ext-core";

interface OutputAppendHandle {
	readonly uri: OutputUri;
	append(data: Uint8Array): void;
	finalize(): OutputUri;
}

export const DEFAULT_VISIBLE_TAIL_BYTES: number = 10 * 1024;

export interface BashOutputSinkOptions {
	readonly outputs?: OutputRegistry;
	readonly reserveOutput?: boolean;
	readonly tailBytes?: number;
}

export interface BashOutputResult {
	readonly output: string;
	readonly truncated: boolean;
	readonly outputUri?: OutputUri;
}

/** Collects complete output while exposing only a bounded, UTF-8-safe tail. */
export class BashOutputSink {
	readonly #outputs: OutputRegistry | undefined;
	readonly #tailBytes: number;
	#output: OutputAppendHandle | undefined;
	#tail: Buffer[] = [];
	#tailLength: number = 0;
	#pending: Buffer[] = [];
	#totalLength: number = 0;
	#finished: BashOutputResult | undefined;

	constructor(options: BashOutputSinkOptions = {}) {
		this.#outputs = options.outputs;
		this.#tailBytes = options.tailBytes ?? DEFAULT_VISIBLE_TAIL_BYTES;
		if (!Number.isSafeInteger(this.#tailBytes) || this.#tailBytes < 1)
			throw new Error("tailBytes must be a positive safe integer");
		if (options.reserveOutput === true && this.#outputs !== undefined)
			this.#output = this.#outputs.createAppend();
	}

	/** Reserved URI, if async output was configured with an output registry. */
	get outputUri(): OutputUri | undefined {
		return this.#output?.uri;
	}

	push(data: Uint8Array): void {
		if (this.#finished !== undefined) throw new Error("Output sink is finalized");
		if (data.byteLength === 0) return;
		const chunk = Buffer.from(data);
		this.#totalLength += chunk.byteLength;
		this.#output?.append(chunk);
		this.#tail.push(chunk);
		this.#tailLength += chunk.byteLength;
		if (this.#output === undefined) {
			this.#pending.push(chunk);
		}
		if (this.#totalLength > this.#tailBytes && this.#output === undefined) {
			this.#output = this.#outputs?.createAppend();
			if (this.#output !== undefined)
				for (const pending of this.#pending) this.#output.append(pending);
		}
		if (this.#totalLength > this.#tailBytes) {
			this.#pending = [];
			const keep = this.#tailBytes + 3;
			let drop = this.#tailLength - keep;
			while (drop > 0) {
				const first = this.#tail[0];
				if (first === undefined) break;
				if (first.byteLength <= drop) {
					this.#tail.shift();
					drop -= first.byteLength;
					this.#tailLength -= first.byteLength;
				} else {
					this.#tail[0] = first.subarray(drop);
					this.#tailLength -= drop;
					drop = 0;
				}
			}
		}
	}

	/** Returns current tail without closing its optional output stream. */
	snapshot(): BashOutputResult {
		const bytes = Buffer.concat(this.#tail);
		let start = Math.max(0, bytes.byteLength - this.#tailBytes);
		while (start > 0 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start -= 1;
		return {
			output: bytes.subarray(start).toString("utf8"),
			truncated: this.#totalLength > this.#tailBytes,
			...(this.#output === undefined ? {} : { outputUri: this.#output.uri }),
		};
	}

	finish(): BashOutputResult {
		if (this.#finished !== undefined) return this.#finished;
		const result: BashOutputResult = {
			...this.snapshot(),
			...(this.#output === undefined ? {} : { outputUri: this.#output.finalize() }),
		};
		this.#finished = result;
		return result;
	}
}
