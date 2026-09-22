export const DEFAULT_VISIBLE_TAIL_BYTES = 10 * 1024;

export interface BashOutputSinkOptions {
	readonly tailBytes?: number;
}

export interface BashOutputResult {
	readonly output: string;
	readonly truncated: boolean;
	readonly totalLines: number;
}

export class BashOutputSink {
	readonly #tailBytes: number;
	#tail: Buffer[] = [];
	#tailLength = 0;
	#totalLength = 0;
	#newlineCount = 0;
	#endsWithNewline = true;
	#finished: BashOutputResult | undefined;

	constructor(options: BashOutputSinkOptions = {}) {
		this.#tailBytes = options.tailBytes ?? DEFAULT_VISIBLE_TAIL_BYTES;
		if (!Number.isSafeInteger(this.#tailBytes) || this.#tailBytes < 1)
			throw new Error("tailBytes must be a positive safe integer");
	}

	push(data: Uint8Array): void {
		if (this.#finished !== undefined) throw new Error("Output sink is finalized");
		if (data.byteLength === 0) return;
		const chunk = Buffer.from(data);
		this.#totalLength += chunk.byteLength;
		for (const byte of chunk) {
			if (byte === 0x0a) {
				this.#newlineCount += 1;
				this.#endsWithNewline = true;
			} else if (byte !== 0x0d) this.#endsWithNewline = false;
		}
		this.#tail.push(chunk);
		this.#tailLength += chunk.byteLength;
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

	snapshot(): BashOutputResult {
		const bytes = Buffer.concat(this.#tail);
		let start = Math.max(0, bytes.byteLength - this.#tailBytes);
		while (start > 0 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start -= 1;
		return {
			output: bytes.subarray(start).toString("utf8"),
			truncated: this.#totalLength > this.#tailBytes,
			totalLines:
				this.#totalLength === 0 ? 0 : this.#newlineCount + (this.#endsWithNewline ? 0 : 1),
		};
	}

	finish(): BashOutputResult {
		if (this.#finished !== undefined) return this.#finished;
		this.#finished = this.snapshot();
		return this.#finished;
	}
}
