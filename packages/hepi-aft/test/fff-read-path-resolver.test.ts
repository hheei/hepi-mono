import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FffRuntime } from "../../hepi-tools/src/fff/fff.js";
import { FffReadPathResolver, locationToReadParams } from "../src/aft/fff-read-path-resolver.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hepi-aft-fff-read-"));
	temporaryPaths.push(path);
	return path;
}

function finder(items: readonly string[], scores: readonly number[]) {
	return {
		destroy() {},
		fileSearch: () => ({
			ok: true as const,
			value: {
				items: items.map((relativePath) => ({
					relativePath,
					totalFrecencyScore: 0,
					gitStatus: "clean",
				})),
				scores: scores.map((total) => ({
					total,
					baseScore: total,
					exactMatch: false,
					matchType: "fuzzy",
				})),
			},
		}),
		trackQuery: () => ({ ok: true as const, value: undefined }),
		waitForScan: async () => ({ ok: true as const, value: true }),
	};
}

describe("AFT FFF read path resolver", () => {
	test("uses one strong FFF candidate for an approximate read path", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "config-loader.ts"), "export {};\n");
		const resolver = new FffReadPathResolver(root, {
			projectRoot: root,
			finder: finder(["config-loader.ts"], [10]) as never,
		});

		expect(await resolver.resolvePath("config loder")).toEqual({
			absolutePath: join(root, "config-loader.ts"),
			location: undefined,
		});
	});

	test("does not guess between similarly scored candidates", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "config-loader.ts"), "export {};\n");
		await writeFile(join(root, "config-reader.ts"), "export {};\n");
		const resolver = new FffReadPathResolver(root, {
			projectRoot: root,
			finder: finder(["config-loader.ts", "config-reader.ts"], [10, 8]) as never,
		});

		await expect(resolver.resolvePath("config")).rejects.toThrow(
			'Could not resolve "config" uniquely',
		);
	});

	test("uses FFF location syntax only when the caller did not provide offset", () => {
		expect(locationToReadParams({ type: "line", line: 42 }, undefined, undefined)).toEqual({
			offset: 42,
			limit: 80,
		});
		expect(locationToReadParams({ type: "line", line: 42 }, 5, 3)).toEqual({ offset: 5, limit: 3 });
	});

	test("shares a finder with the FFF runtime for the same project", async () => {
		const root = await temporaryDirectory();
		const runtime = new FffRuntime(root, { projectRoot: root });
		const resolver = new FffReadPathResolver(root, { projectRoot: root });
		try {
			const runtimeFinder = await runtime.ensure();
			expect(runtimeFinder.isOk()).toBe(true);
			if (runtimeFinder.isErr()) return;
			const getFinder = (resolver as unknown as { getFinder(): Promise<unknown> }).getFinder.bind(
				resolver,
			);
			const [firstResolverFinder, secondResolverFinder] = await Promise.all([
				getFinder(),
				getFinder(),
			]);
			expect(firstResolverFinder).toBe(runtimeFinder.value);
			expect(secondResolverFinder).toBe(runtimeFinder.value);
		} finally {
			resolver.dispose();
			runtime.dispose();
		}
	});
});
