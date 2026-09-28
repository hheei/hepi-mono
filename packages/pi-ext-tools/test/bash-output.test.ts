import { describe, expect, test } from "vitest";
import { BashOutputSink, DEFAULT_VISIBLE_TAIL_BYTES } from "../src/bash-output.js";

/** The straightforward model the sink is expected to reproduce, kept for comparison. */
function reference(chunks: readonly Buffer[], tailBytes: number) {
	let totalLength = 0;
	let newlineCount = 0;
	let endsWithNewline = true;
	for (const chunk of chunks) {
		totalLength += chunk.byteLength;
		for (const byte of chunk) {
			if (byte === 0x0a) {
				newlineCount += 1;
				endsWithNewline = true;
			} else if (byte !== 0x0d) endsWithNewline = false;
		}
	}
	const all = Buffer.concat(chunks);
	const keep = tailBytes + 3;
	let start = Math.max(0, all.byteLength - keep);
	while (start > 0 && ((all[start] ?? 0) & 0xc0) === 0x80) start -= 1;
	const tail = all.subarray(start);
	let outputStart = Math.max(0, tail.byteLength - tailBytes);
	while (outputStart > 0 && ((tail[outputStart] ?? 0) & 0xc0) === 0x80) outputStart -= 1;
	return {
		output: tail.subarray(outputStart).toString("utf8"),
		truncated: totalLength > tailBytes,
		totalLines: totalLength === 0 ? 0 : newlineCount + (endsWithNewline ? 0 : 1),
	};
}

/** Deterministic PRNG so a failing case can be reproduced from its seed. */
function sampler(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

const ALPHABET = ["a", "\n", "\r", "\r\n", "測", "é", "😀", " ", "\t", "\u0000"];

describe("BashOutputSink", () => {
	test("matches the reference model on random byte streams", () => {
		const next = sampler(0x5eed);
		for (let round = 0; round < 40; round++) {
			const chunks: Buffer[] = [];
			const sink = new BashOutputSink(DEFAULT_VISIBLE_TAIL_BYTES);
			const chunkCount = 1 + Math.floor(next() * 40);
			for (let index = 0; index < chunkCount; index++) {
				const parts: string[] = [];
				const partCount = 1 + Math.floor(next() * 30);
				for (let part = 0; part < partCount; part++) {
					parts.push(ALPHABET[Math.floor(next() * ALPHABET.length)] ?? "a");
				}
				const chunk = Buffer.from(parts.join(""), "utf8");
				chunks.push(chunk);
				sink.push(chunk);
				expect(sink.snapshot()).toEqual(reference(chunks, DEFAULT_VISIBLE_TAIL_BYTES));
			}
			expect(sink.finish()).toEqual(reference(chunks, DEFAULT_VISIBLE_TAIL_BYTES));
		}
	});

	test("counts the last line, with or without a trailing newline", () => {
		const sink = new BashOutputSink();
		sink.push(Buffer.from("one\ntwo\nthree"));
		expect(sink.snapshot().totalLines).toBe(3);
		sink.push(Buffer.from("\n"));
		expect(sink.snapshot().totalLines).toBe(3);
		sink.push(Buffer.from("four\n"));
		expect(sink.snapshot().totalLines).toBe(4);
	});

	test("keeps the trailing-newline state across carriage returns", () => {
		const sink = new BashOutputSink();
		sink.push(Buffer.from("line\n"));
		sink.push(Buffer.from("\r"));
		expect(sink.snapshot().totalLines).toBe(1);
		const other = new BashOutputSink();
		other.push(Buffer.from("line"));
		other.push(Buffer.from("\r"));
		expect(other.snapshot().totalLines).toBe(1);
	});

	test("keeps only the tail and reports truncation", () => {
		const sink = new BashOutputSink(16);
		sink.push(Buffer.from("0123456789"));
		sink.push(Buffer.from("abcdefghij"));
		const result = sink.snapshot();
		expect(result.truncated).toBe(true);
		expect(result.output).toBe("456789abcdefghij");
		expect(result.totalLines).toBe(1);
	});

	test("ignores empty chunks and rejects pushes after the final snapshot", () => {
		const sink = new BashOutputSink();
		sink.push(Buffer.alloc(0));
		expect(sink.snapshot()).toEqual({ output: "", truncated: false, totalLines: 0 });
		sink.finish();
		expect(() => sink.push(Buffer.from("late"))).toThrow("Output sink is finalized");
	});

	test("counts lines over a long burst without dropping any", () => {
		const sink = new BashOutputSink(4 * 1024);
		const line = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789\n");
		const chunk = Buffer.concat(Array.from({ length: 512 }, () => line));
		for (let index = 0; index < 100; index++) sink.push(chunk);
		const result = sink.snapshot();
		expect(result.totalLines).toBe(51_200);
		expect(result.truncated).toBe(true);
		expect(result.output.endsWith("\n")).toBe(true);
	});
});
