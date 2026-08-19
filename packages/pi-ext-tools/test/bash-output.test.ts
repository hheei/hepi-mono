import { expect, test } from "bun:test";
import { createOutputRegistry } from "@hheei/pi-ext-core";
import { BashOutputSink, DEFAULT_VISIBLE_TAIL_BYTES } from "../src/bash-output.js";

test("keeps under-limit output visible without output", (): void => {
	const sink = new BashOutputSink();
	sink.push(Buffer.from("small output"));
	expect(sink.finish()).toEqual({ output: "small output", truncated: false, totalLines: 1 });
});

test("promotes threshold overflow and retains early bytes in output", (): void => {
	const outputs = createOutputRegistry();
	const sink = new BashOutputSink({ outputs });
	const early = "early output\n";
	sink.push(Buffer.from(early));
	sink.push(Buffer.alloc(DEFAULT_VISIBLE_TAIL_BYTES, 120));
	const result = sink.finish();
	expect(result.truncated).toBe(true);
	expect(result.outputUri).toMatch(/^output:\/\/[1-9]\d*$/);
	expect(outputs.read(result.outputUri ?? "")).toBe(early + "x".repeat(DEFAULT_VISIBLE_TAIL_BYTES));
	expect(result.output).toBe("x".repeat(DEFAULT_VISIBLE_TAIL_BYTES));
	expect(result.totalLines).toBe(2);
});

test("pre-reserves async output and keeps stable URI tied to output", (): void => {
	const outputs = createOutputRegistry();
	const sink = new BashOutputSink({ outputs, reserveOutput: true });
	const reserved = sink.outputUri;
	expect(reserved).toMatch(/^output:\/\/[1-9]\d*$/);
	sink.push(Buffer.from("async output"));
	const result = sink.finish();
	expect(result.outputUri).toBe(reserved);
	expect(outputs.read(reserved ?? "")).toBe("async output");
});

test("reports a running bounded tail without finalizing its output", (): void => {
	const outputs = createOutputRegistry();
	const sink = new BashOutputSink({ outputs, reserveOutput: true, tailBytes: 2 });
	const reserved = sink.outputUri;
	if (reserved === undefined) throw new Error("Expected reserved output URI");
	sink.push(Buffer.from("abc"));
	expect(sink.snapshot()).toEqual({
		output: "bc",
		truncated: true,
		totalLines: 1,
		outputUri: reserved,
	});
	expect(outputs.read(reserved ?? "")).toBe("abc");
});

test("counts logical lines across a sliding tail", (): void => {
	const sink = new BashOutputSink({ tailBytes: 8 });
	const seen: number[] = [];
	for (let index = 0; index < 20; index += 1) {
		sink.push(Buffer.from(`${index}\n`));
		seen.push(sink.snapshot().totalLines);
	}
	expect(seen).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
	expect(sink.snapshot().output.split("\n").filter(Boolean).length).toBeLessThan(20);
});

test("keeps split UTF-8 byte boundaries valid", (): void => {
	const sink = new BashOutputSink({ tailBytes: 4 });
	const bytes = Buffer.from("A😀B");
	sink.push(bytes.subarray(0, 2));
	sink.push(bytes.subarray(2, 4));
	sink.push(bytes.subarray(4));
	const result = sink.finish();
	expect(result.output).toBe("😀B");
});
