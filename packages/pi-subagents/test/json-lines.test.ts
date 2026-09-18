import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import {
	attachJsonLineReader,
	JsonLineError,
	serializeJsonLine,
	writeJsonLine,
} from "../src/json-lines.js";

interface Collected {
	readonly values: unknown[];
	readonly errors: JsonLineError[];
	readonly detach: () => void;
}

function collect(stream: PassThrough, maxFrameBytes = 1024): Collected {
	const values: unknown[] = [];
	const errors: JsonLineError[] = [];
	const detach = attachJsonLineReader(stream, {
		maxFrameBytes,
		onValue: (value) => values.push(value),
		onError: (error) => errors.push(error),
	});
	return { values, errors, detach };
}

describe("JSON line transport", () => {
	test("parses frames split across chunks and ignores blank lines", () => {
		const stream = new PassThrough();
		const collected = collect(stream);
		stream.write('{"a":');
		stream.write('1}\n\n{"b":2}\r\n');
		expect(collected.values).toEqual([{ a: 1 }, { b: 2 }]);
		expect(collected.errors).toEqual([]);
		collected.detach();
	});

	test("fails once with frame_too_large and stops reading", () => {
		const stream = new PassThrough();
		const collected = collect(stream, 8);
		stream.write("x".repeat(20));
		expect(collected.errors).toHaveLength(1);
		expect(collected.errors[0]?.code).toBe("frame_too_large");
		stream.write('{"a":1}\n');
		expect(collected.values).toEqual([]);
	});

	test("fails with malformed_json and never leaks partial frames", () => {
		const stream = new PassThrough();
		const collected = collect(stream);
		stream.write("{not json}\n");
		expect(collected.errors[0]?.code).toBe("malformed_json");
	});

	test("reports stream errors once and detaches", () => {
		const stream = new PassThrough();
		const collected = collect(stream);
		stream.emit("error", new Error("socket hang up"));
		expect(collected.errors[0]?.code).toBe("stream_error");
		expect(collected.errors[0]?.message).toBe("socket hang up");
	});

	test("detaching stops delivery without reporting an error", () => {
		const stream = new PassThrough();
		const collected = collect(stream);
		collected.detach();
		stream.write('{"a":1}\n');
		expect(collected.values).toEqual([]);
		expect(collected.errors).toEqual([]);
	});

	test("rejects a non-positive frame limit", () => {
		const stream = new PassThrough();
		expect(() =>
			attachJsonLineReader(stream, {
				maxFrameBytes: 0,
				onValue: () => undefined,
				onError: () => undefined,
			}),
		).toThrow(/positive safe integer/);
		stream.destroy();
	});

	test("serializes one line and enforces the frame limit", () => {
		expect(serializeJsonLine({ a: 1 }, 32).toString("utf8")).toBe('{"a":1}\n');
		expect(() => serializeJsonLine({ a: "x".repeat(40) }, 8)).toThrow(JsonLineError);
	});

	test("writes a frame to a writable stream", async () => {
		const stream = new PassThrough();
		const collected = collect(stream);
		await writeJsonLine(stream, { type: "hello" }, 64);
		expect(collected.values).toEqual([{ type: "hello" }]);
		await expect(writeJsonLine(stream, { text: "x".repeat(100) }, 8)).rejects.toThrow(
			/frame limit/i,
		);
		collected.detach();
	});
});
