import { expect, test } from "bun:test";
import { createArtifactRegistry } from "@hheei/pi-ext-core";
import { BashOutputSink, DEFAULT_VISIBLE_TAIL_BYTES } from "../src/bash-output.js";

test("keeps under-limit output visible without artifact", (): void => {
	const sink = new BashOutputSink();
	sink.push(Buffer.from("small output"));
	expect(sink.finish()).toEqual({ output: "small output", truncated: false });
});

test("promotes threshold overflow and retains early bytes in artifact", (): void => {
	const artifacts = createArtifactRegistry();
	const sink = new BashOutputSink({ artifacts });
	const early = "early output\n";
	sink.push(Buffer.from(early));
	sink.push(Buffer.alloc(DEFAULT_VISIBLE_TAIL_BYTES, 120));
	const result = sink.finish();
	expect(result.truncated).toBe(true);
	expect(result.artifactUri).toMatch(/^artifact:\/\/[1-9]\d*$/);
	expect(artifacts.read(result.artifactUri ?? "")).toBe(
		early + "x".repeat(DEFAULT_VISIBLE_TAIL_BYTES),
	);
	expect(result.output).toBe("x".repeat(DEFAULT_VISIBLE_TAIL_BYTES));
});

test("pre-reserves async artifact and keeps stable URI tied to artifact", (): void => {
	const artifacts = createArtifactRegistry();
	const sink = new BashOutputSink({ artifacts, reserveArtifact: true });
	const reserved = sink.artifactUri;
	expect(reserved).toMatch(/^artifact:\/\/[1-9]\d*$/);
	sink.push(Buffer.from("async output"));
	const result = sink.finish();
	expect(result.artifactUri).toBe(reserved);
	expect(artifacts.read(reserved ?? "")).toBe("async output");
});

test("reports a running bounded tail without finalizing its artifact", (): void => {
	const artifacts = createArtifactRegistry();
	const sink = new BashOutputSink({ artifacts, reserveArtifact: true, tailBytes: 2 });
	const reserved = sink.artifactUri;
	sink.push(Buffer.from("abc"));
	expect(sink.snapshot()).toEqual({
		output: "bc",
		truncated: true,
		artifactUri: reserved,
	});
	expect(artifacts.read(reserved ?? "")).toBe("abc");
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
