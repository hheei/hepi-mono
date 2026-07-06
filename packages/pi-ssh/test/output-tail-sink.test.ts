import { expect, test } from "bun:test";
import { OutputTailSink } from "../src/scripts/output-tail-sink.js";
import { MAX_OUTPUT_BYTES } from "../src/scripts/ssh-exec.js";

test("OutputTailSink retains only the last maxBytes bytes", () => {
	const sink = new OutputTailSink(8);

	sink.write(Buffer.from("12345"));
	sink.write(Buffer.from("67890"));

	expect(sink.dump()).toMatchObject({
		text: "34567890",
		stdout: "34567890",
		stderr: "",
		truncated: true,
	});
});

test("OutputTailSink reports untruncated small output", () => {
	const sink = new OutputTailSink(MAX_OUTPUT_BYTES);

	sink.write(Buffer.from("small output\n"));

	expect(sink.dump()).toMatchObject({
		text: "small output\n",
		stdout: "small output\n",
		stderr: "",
		truncated: false,
		totalBytes: Buffer.byteLength("small output\n"),
		outputBytes: Buffer.byteLength("small output\n"),
	});
});

test("OutputTailSink retains one combined tail across stdout and stderr", () => {
	const sink = new OutputTailSink(10);

	sink.write("stdout", "out-12345");
	sink.write("stderr", "err-67890");

	const dump = sink.dump();
	expect(Buffer.byteLength(dump.text)).toBeLessThanOrEqual(10);
	expect(dump).toMatchObject({
		text: "5err-67890",
		stdout: "5",
		stderr: "err-67890",
		truncated: true,
	});
});

test("OutputTailSink preserves retained stdout and stderr order in combined output", () => {
	const sink = new OutputTailSink(MAX_OUTPUT_BYTES);

	sink.write("stdout", "out-1\n");
	sink.write("stderr", "err-1\n");
	sink.write("stdout", "out-2\n");
	sink.write("stderr", "err-2\n");

	expect(sink.dump()).toMatchObject({
		text: "out-1\nerr-1\nout-2\nerr-2\n",
		stdout: "out-1\nout-2\n",
		stderr: "err-1\nerr-2\n",
		truncated: false,
	});
});

test("OutputTailSink truncates on UTF-8 boundaries", () => {
	const sink = new OutputTailSink(4);

	sink.write("stdout", "x🙂y");

	const dump = sink.dump();
	expect(dump.text).toBe("y");
	expect(dump.text).not.toContain("\uFFFD");
});
