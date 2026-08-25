import { describe, expect, test } from "vitest";
import { JsRuntime } from "../src/eval/runtime.js";

describe("Eval runtime", () => {
	test("routes console, print, display, and awaited final values through one run", async () => {
		const runtime = new JsRuntime(process.cwd());
		const text: string[] = [];
		const displays: unknown[] = [];
		try {
			const value = await runtime.runWithHooks(
				'console.log("one"); print("two"); display({ value: 3 }); await Promise.resolve(4)',
				{
					cwd: process.cwd(),
					onText: (line) => text.push(line),
					onDisplay: (item) => displays.push(item),
					callTool: async () => undefined,
				},
			);
			expect(value).toBe(4);
			expect(text).toEqual(["one\n", "two\n"]);
			expect(displays).toEqual([{ value: 3 }]);
		} finally {
			runtime.dispose();
		}
	});

	test("does not install helper globals on the Pi host", async () => {
		const originalPrint = (globalThis as Record<string, unknown>).print;
		const runtime = new JsRuntime(process.cwd());
		try {
			expect((globalThis as Record<string, unknown>).print).toBe(originalPrint);
		} finally {
			runtime.dispose();
		}
		expect((globalThis as Record<string, unknown>).print).toBe(originalPrint);
	});

	test("keeps completed top-level bindings and parses semicolons in awaited expressions", async () => {
		const runtime = new JsRuntime(process.cwd());
		try {
			expect(
				await runtime.runWithHooks('let value = await Promise.resolve("x;y"); value', hooks()),
			).toBe("x;y");
			expect(await runtime.runWithHooks("value", hooks())).toBe("x;y");
		} finally {
			runtime.dispose();
		}
	});

	test("uses the last expression even when it has a trailing semicolon", async () => {
		const runtime = new JsRuntime(process.cwd());
		try {
			expect(await runtime.runWithHooks('print("hi"); 1;', hooks())).toBe(1);
		} finally {
			runtime.dispose();
		}
	});

	test("persists bindings from a top-level return and from a later throw", async () => {
		const runtime = new JsRuntime(process.cwd());
		try {
			expect(await runtime.runWithHooks("let kept = 7; return kept", hooks())).toBe(7);
			expect(await runtime.runWithHooks("kept", hooks())).toBe(7);
			await expect(
				runtime.runWithHooks('let extra = 8; throw new Error("boom")', hooks()),
			).rejects.toThrow("boom");
			expect(await runtime.runWithHooks("extra", hooks())).toBe(8);
		} finally {
			runtime.dispose();
		}
	});

	test("rejects an already aborted signal before running source", async () => {
		const runtime = new JsRuntime(process.cwd());
		const abort = new AbortController();
		abort.abort();
		try {
			await expect(runtime.runWithHooks("1", hooks(), abort.signal)).rejects.toThrow();
		} finally {
			runtime.dispose();
		}
	});

	test("rejects module-loading source before execution", async () => {
		const runtime = new JsRuntime(process.cwd());
		try {
			await expect(runtime.runWithHooks('require("node:fs")', hooks())).rejects.toThrow(
				"module loading",
			);
		} finally {
			runtime.dispose();
		}
	});

	test("keeps a caught nested failure in the script's control flow", async () => {
		const runtime = new JsRuntime(process.cwd());
		const text: string[] = [];
		try {
			const value = await runtime.runWithHooks(
				'try { await tool.read({ path: "missing" }); } catch (error) { print(error.message); }; await Promise.resolve("recovered")',
				{
					...hooks(),
					onText: (line) => text.push(line),
					callTool: async () => Promise.reject(new Error("read failed")),
				},
			);
			expect(value).toBe("recovered");
			expect(text).toEqual(["read failed\n"]);
		} finally {
			runtime.dispose();
		}
	});
});

function hooks() {
	return {
		cwd: process.cwd(),
		onText: (_text: string): void => {},
		onDisplay: (_value: unknown): void => {},
		callTool: async (_name: string, _args: unknown): Promise<unknown> => undefined,
	};
}
