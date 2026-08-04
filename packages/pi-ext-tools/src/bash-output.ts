import type { ArtifactRegistry, ArtifactUri } from "@hheei/pi-ext-core";

interface ArtifactAppendHandle {
	readonly uri: ArtifactUri;
	append(data: Uint8Array): void;
	finalize(): ArtifactUri;
}

export const DEFAULT_VISIBLE_TAIL_BYTES: number = 10 * 1024;

export interface BashOutputSinkOptions {
	readonly artifacts?: ArtifactRegistry;
	readonly reserveArtifact?: boolean;
	readonly tailBytes?: number;
}

export interface BashOutputResult {
	readonly output: string;
	readonly truncated: boolean;
	readonly artifactUri?: ArtifactUri;
}

/** Collects complete output while exposing only a bounded, UTF-8-safe tail. */
export class BashOutputSink {
	readonly #artifacts: ArtifactRegistry | undefined;
	readonly #tailBytes: number;
	#artifact: ArtifactAppendHandle | undefined;
	#tail: Buffer[] = [];
	#tailLength: number = 0;
	#pending: Buffer[] = [];
	#totalLength: number = 0;
	#finished: BashOutputResult | undefined;

	constructor(options: BashOutputSinkOptions = {}) {
		this.#artifacts = options.artifacts;
		this.#tailBytes = options.tailBytes ?? DEFAULT_VISIBLE_TAIL_BYTES;
		if (!Number.isSafeInteger(this.#tailBytes) || this.#tailBytes < 1)
			throw new Error("tailBytes must be a positive safe integer");
		if (options.reserveArtifact === true && this.#artifacts !== undefined)
			this.#artifact = this.#artifacts.createAppend();
	}

	/** Reserved URI, if async output was configured with an artifact registry. */
	get artifactUri(): ArtifactUri | undefined {
		return this.#artifact?.uri;
	}

	push(data: Uint8Array): void {
		if (this.#finished !== undefined) throw new Error("Output sink is finalized");
		if (data.byteLength === 0) return;
		const chunk = Buffer.from(data);
		this.#totalLength += chunk.byteLength;
		this.#artifact?.append(chunk);
		this.#tail.push(chunk);
		this.#tailLength += chunk.byteLength;
		if (this.#artifact === undefined) {
			this.#pending.push(chunk);
		}
		if (this.#totalLength > this.#tailBytes && this.#artifact === undefined) {
			this.#artifact = this.#artifacts?.createAppend();
			if (this.#artifact !== undefined)
				for (const pending of this.#pending) this.#artifact.append(pending);
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

	/** Returns current tail without closing its optional artifact stream. */
	snapshot(): BashOutputResult {
		const bytes = Buffer.concat(this.#tail);
		let start = Math.max(0, bytes.byteLength - this.#tailBytes);
		while (start > 0 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start -= 1;
		return {
			output: bytes.subarray(start).toString("utf8"),
			truncated: this.#totalLength > this.#tailBytes,
			...(this.#artifact === undefined ? {} : { artifactUri: this.#artifact.uri }),
		};
	}

	finish(): BashOutputResult {
		if (this.#finished !== undefined) return this.#finished;
		const result: BashOutputResult = {
			...this.snapshot(),
			...(this.#artifact === undefined ? {} : { artifactUri: this.#artifact.finalize() }),
		};
		this.#finished = result;
		return result;
	}
}
