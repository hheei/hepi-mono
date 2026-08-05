import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { ExternalGrepScopeError } from "../../src/fff/errors.js";
import { FffRuntime } from "../../src/fff/fff.js";

describe("FFF runtime", () => {
	test("continues grep pages after the runtime is recreated", async () => {
		const seenOffsets: Array<number | null> = [];
		const page = (options: { cursor?: { _offset: number } | null }) => {
			seenOffsets.push(options.cursor ? options.cursor._offset : null);
			const secondPage = options.cursor?._offset === 1;
			return {
				ok: true as const,
				value: {
					items: [
						{
							relativePath: secondPage ? "second.ts" : "first.ts",
							lineNumber: 1,
							lineContent: "needle",
							matchRanges: [],
						},
					],
					nextCursor: secondPage ? null : { __brand: "GrepCursor", _offset: 1 },
				},
			};
		};
		const finder = {
			grep: (_query: string, options: { cursor?: { _offset: number } | null }) => page(options),
			multiGrep: (options: { cursor?: { _offset: number } | null }) => page(options),
		};
		const firstRuntime = new FffRuntime("/tmp", { finder: finder as never });
		const first = await firstRuntime.grepSearch({ pattern: "needle", limit: 1 });
		if (first.isErr()) throw first.error;
		const cursor = first.value.nextCursor;
		if (!cursor) throw new Error("Expected a continuation cursor");

		const secondRuntime = new FffRuntime("/tmp", { finder: finder as never });
		const second = await secondRuntime.grepSearch({ pattern: "needle", limit: 1, cursor });
		if (second.isErr()) throw second.error;
		expect(second.value.items[0]?.relativePath).toBe("second.ts");
		expect(seenOffsets).toEqual([null, 1]);
	});

	test("uses cwd as the index root and bounds explicit scan waiting", async () => {
		const waits: number[] = [];
		const runtime = new FffRuntime("/tmp/session", {
			finder: {
				waitForScan: async (timeoutMs: number) => {
					waits.push(timeoutMs);
					return { ok: true as const, value: false };
				},
				healthCheck: () => ({
					ok: true as const,
					value: { filePicker: { indexedFiles: 7 } },
				}),
			} as never,
		});

		expect((await runtime.getMetadata()).projectRoot).toBe("/tmp/session");
		const warmed = await runtime.warm(25);
		if (warmed.isErr()) throw warmed.error;
		expect(warmed.value).toMatchObject({ ready: false, indexedFiles: 7 });
		expect(waits).toEqual([25]);
	});

	test("destroys a finder that finishes initialization after disposal", async () => {
		const runtime = new FffRuntime("/tmp");
		let resolveInitialization: (result: unknown) => void = () => undefined;
		const pendingInitialization = new Promise<unknown>((resolve) => {
			resolveInitialization = resolve;
		});
		(runtime as unknown as { initPromise: Promise<unknown> }).initPromise = pendingInitialization;
		const ensuring = runtime.ensure();
		runtime.dispose();
		const destroyed: string[] = [];
		resolveInitialization(Result.ok({ destroy: () => destroyed.push("destroyed") } as never));
		const result = await ensuring;
		expect(result.isErr()).toBe(true);
		expect(destroyed).toEqual(["destroyed"]);
	});

	test("rejects an external grep scope before creating an FFF constraint", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "hepi-fff-project-"));
		const externalRoot = await mkdtemp(join(tmpdir(), "hepi-fff-external-"));
		const externalPath = join(externalRoot, "outside.txt");
		await writeFile(externalPath, "outside\n", "utf8");
		try {
			const runtime = new FffRuntime(projectRoot, {
				projectRoot,
				finder: {} as never,
			});

			const result = await runtime.grepSearch({ pattern: "outside", pathQuery: externalPath });

			expect(result.isErr()).toBe(true);
			if (result.isErr()) expect(ExternalGrepScopeError.is(result.error)).toBe(true);
		} finally {
			await Promise.all([
				rm(projectRoot, { recursive: true, force: true }),
				rm(externalRoot, { recursive: true, force: true }),
			]);
		}
	});
});
