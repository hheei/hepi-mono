import { describe, expect, test } from "bun:test";
import { type BrushShell, createBrushBashOperations } from "../src/bash-runtime.js";

describe("Brush Bash operations", () => {
	test("maps Pi execution context, streamed output, and native result", async (): Promise<void> => {
		let options: Parameters<BrushShell["run"]>[0] | undefined;
		const shell: BrushShell = {
			async run(next, onChunk) {
				options = next;
				onChunk("native output\n");
				return { exitCode: 0, cancelled: false, timedOut: false };
			},
			async abort() {},
		};
		const chunks: Buffer[] = [];

		const result = await createBrushBashOperations(() => shell).exec(
			"printf native",
			process.cwd(),
			{
				onData: (chunk) => chunks.push(chunk),
				timeout: 2.5,
				env: { PRESENT: "yes", OMITTED: undefined },
			},
		);

		expect(result).toEqual({ exitCode: 0 });
		expect(chunks.map(String)).toEqual(["native output\n"]);
		expect(options).toMatchObject({
			command: "printf native",
			cwd: process.cwd(),
			env: { PRESENT: "yes" },
			timeoutMs: 2500,
		});
	});

	test("preserves Pi abort and timeout error contracts", async (): Promise<void> => {
		const cancelled: BrushShell = {
			async run() {
				return { exitCode: undefined, cancelled: true, timedOut: false };
			},
			async abort() {},
		};
		const timedOut: BrushShell = {
			async run() {
				return { exitCode: undefined, cancelled: false, timedOut: true };
			},
			async abort() {},
		};
		const options = { onData: () => undefined, timeout: 3 };

		await expect(
			createBrushBashOperations(() => cancelled).exec("sleep 1", process.cwd(), options),
		).rejects.toThrow("aborted");
		await expect(
			createBrushBashOperations(() => timedOut).exec("sleep 1", process.cwd(), options),
		).rejects.toThrow("timeout:3");
	});
});
