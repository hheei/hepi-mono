import { describe, expect, test } from "vitest";
import { runCommand, shellQuote } from "../src/index.js";

const ECHO = 'process.stdout.write("out");process.stderr.write("err")';
const READ_STDIN =
	"let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>process.stdout.write(d.toUpperCase()))";

describe("runCommand", () => {
	test("collects stdout, stderr and the exit code", async () => {
		const result = await runCommand(process.execPath, ["-e", ECHO]);
		expect(result.code).toBe(0);
		expect(result.stdout.toString("utf8")).toBe("out");
		expect(result.stderr.toString("utf8")).toBe("err");
		expect(result.timedOut).toBe(false);
		expect(result.stdoutTruncated).toBe(false);
	});

	test("resolves a non-zero exit code instead of rejecting", async () => {
		const result = await runCommand(process.execPath, ["-e", "process.exit(3)"]);
		expect(result.code).toBe(3);
	});

	test("writes the input to stdin", async () => {
		const result = await runCommand(process.execPath, ["-e", READ_STDIN], { input: "abc" });
		expect(result.stdout.toString("utf8")).toBe("ABC");
	});

	test("reports a timeout after killing the command", async () => {
		const result = await runCommand(process.execPath, ["-e", "setTimeout(()=>{},5000)"], {
			timeoutMs: 50,
		});
		expect(result.timedOut).toBe(true);
	});

	test("reports a stdout cap", async () => {
		const result = await runCommand(
			process.execPath,
			["-e", 'process.stdout.write("x".repeat(256))'],
			{ maxStdoutBytes: 128 },
		);
		expect(result.stdoutTruncated).toBe(true);
		expect(result.stdout.byteLength).toBeLessThanOrEqual(256);
	});

	test("observes both streams while collecting them", async () => {
		const chunks: string[] = [];
		await runCommand(process.execPath, ["-e", ECHO], {
			onData: (chunk) => chunks.push(chunk.toString("utf8")),
		});
		expect(chunks.join("")).toBe("outerr");
	});

	test("rejects with an AbortError when the signal fires", async () => {
		const controller = new AbortController();
		const running = runCommand(process.execPath, ["-e", "setTimeout(()=>{},5000)"], {
			signal: controller.signal,
		});
		controller.abort();
		const error = await running.then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("AbortError");
	});

	test("rejects immediately for an already aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			runCommand(process.execPath, ["-e", ECHO], { signal: controller.signal }),
		).rejects.toThrow("Operation aborted");
	});

	test("rejects when the command cannot start", async () => {
		await expect(runCommand("/nonexistent/hepi-command", [])).rejects.toThrow();
	});
});

describe("shellQuote", () => {
	test("wraps a value in single quotes and escapes embedded quotes", () => {
		expect(shellQuote("plain")).toBe("'plain'");
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});
});
