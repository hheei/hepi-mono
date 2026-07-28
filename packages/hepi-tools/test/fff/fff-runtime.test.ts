import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { ExternalGrepScopeError } from "../../src/fff/errors.js";
import { FffRuntime } from "../../src/fff/fff.js";

describe("FFF runtime", () => {
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
		resolveInitialization(
			Result.ok({
				finder: {} as never,
				release: () => destroyed.push("destroyed"),
			}),
		);
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
