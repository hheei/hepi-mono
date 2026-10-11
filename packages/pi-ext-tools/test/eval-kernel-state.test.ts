import { describe, expect, test } from "vitest";
import { EvalKernelHost } from "../src/eval/kernel/host.js";
import type { EvalRunResult } from "../src/eval/runtime.js";

/**
 * Drives the real kernel through the host so the protocol, the drain barrier, and the
 * namespace report are exercised together rather than against a double.
 */
async function run(
	host: EvalKernelHost,
	code: string,
	options: { readonly reset?: boolean } = {},
): Promise<EvalRunResult & { readonly background: string }> {
	const text: string[] = [];
	const background: string[] = [];
	const result = await host.runWithHooks(
		code,
		{
			cwd: process.cwd(),
			onText: (chunk) => text.push(chunk),
			onDisplay: (): void => undefined,
			onBackground: (chunk) => background.push(chunk),
			callTool: async (name) => {
				throw new Error(`unexpected nested call: ${name}`);
			},
		},
		undefined,
		options.reset,
	);
	return { ...result, background: background.join("") };
}

describe("Eval kernel namespace reporting", () => {
	test("reports names a cell added and imports it repeated", async () => {
		const host = new EvalKernelHost(process.cwd());
		try {
			const first = await run(host, "import os\nx = 1");
			expect(first.state?.names).toBe(2);
			expect([...(first.state?.added ?? [])].sort()).toEqual(["os", "x"]);
			expect(first.state?.redundant).toEqual([]);

			// The second cell proves the kernel kept the scope: the repeat is reported, not hidden.
			const second = await run(host, "import os\ny = 2");
			expect(second.state?.names).toBe(3);
			expect(second.state?.added).toEqual(["y"]);
			expect(second.state?.redundant).toEqual(["os"]);
			expect(second.restarted).toBe(false);
		} finally {
			host.dispose();
		}
	});

	test("reports the namespace on a failed cell so the model still knows what survived", async () => {
		const host = new EvalKernelHost(process.cwd());
		try {
			await run(host, "kept = 1");
			const failed = await run(host, "kept + missing_name").catch((error: Error) => error);
			expect(failed).toBeInstanceOf(Error);
			// The failure reaches the model as an error, so the report rides the next successful cell.
			const next = await run(host, "names()");
			expect(next.value).toEqual(["kept"]);
			expect(next.state?.redundant).toEqual([]);
		} finally {
			host.dispose();
		}
	});

	test("stays quiet for an explicit reset, which is a request rather than a loss", async () => {
		const host = new EvalKernelHost(process.cwd());
		try {
			await run(host, "kept = 1");
			const afterReset = await run(host, "kept = 2", { reset: true });
			expect(afterReset.restarted).toBe(false);
			expect(afterReset.state?.added).toEqual(["kept"]);
		} finally {
			host.dispose();
		}
	});

	test("reports a restart when a cell killed the kernel", async () => {
		const host = new EvalKernelHost(process.cwd());
		try {
			await run(host, "kept = 1");
			// `sys.exit` is a BaseException, so it takes the kernel process down with the cell.
			const died = await run(host, "import sys\nsys.exit(3)").catch((error: Error) => error);
			expect(died).toBeInstanceOf(Error);
			const next = await run(host, "1 + 1");
			expect(next.restarted).toBe(true);
			expect(next.state?.names).toBe(0);
		} finally {
			host.dispose();
		}
	});

	test("carries output from a detached child into the next cell instead of dropping it", async () => {
		const host = new EvalKernelHost(process.cwd());
		try {
			await run(
				host,
				[
					"import subprocess, sys",
					"subprocess.Popen([sys.executable, '-c', \"import time; time.sleep(0.3); print('ORPHAN')\"])",
				].join("\n"),
			);
			await new Promise((resolve) => setTimeout(resolve, 600));
			const next = await run(host, "1 + 1");
			// The child wrote to fd 1 after its cell ended; the barrier keeps the bytes and the
			// next cell reports them rather than letting them corrupt its own transcript.
			expect(next.background).toContain("ORPHAN");
			expect(next.value).toBe(2);
		} finally {
			host.dispose();
		}
	});
});
