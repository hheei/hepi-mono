import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoadoutStorage, initialLoadoutScope } from "../../../src/loadout/storage.js";

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "pi-basics-loadout-"));
	const paths = {
		globalPath: join(directory, "global.json"),
		projectPath: join(directory, "project.json"),
	};
	return { directory, paths, storage: createLoadoutStorage(paths) };
}

async function cleanup(directory: string) {
	await rm(directory, { recursive: true, force: true });
}

describe("loadout storage", () => {
	test("prefers project scope when cwd contains a .pi directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-basics-loadout-scope-"));
		try {
			expect(await initialLoadoutScope(directory)).toBe("global");
			await mkdir(join(directory, ".pi"));
			expect(await initialLoadoutScope(directory)).toBe("project");
		} finally {
			await cleanup(directory);
		}
	});

	test("preserves unrelated root and unknown loadout keys", async () => {
		const { directory, paths, storage } = await fixture();
		try {
			await writeFile(
				paths.globalPath,
				JSON.stringify({
					general: { mode: "auto" },
					"pi-basics-loadout": { "unknown:item": true, "tool:read": false },
				}),
			);
			await storage.update("global", "tool:read", true);
			expect(JSON.parse(await readFile(paths.globalPath, "utf8"))).toEqual({
				general: { mode: "auto" },
				"pi-basics-loadout": { "unknown:item": true, "tool:read": true },
			});
		} finally {
			await cleanup(directory);
		}
	});

	test("reads missing files as empty and undefined deletes keys", async () => {
		const { directory, storage } = await fixture();
		try {
			expect(await storage.load()).toEqual({ global: {}, project: {} });
			await storage.update("project", "tool:read", false);
			await storage.update("project", "tool:read", undefined);
			await storage.update("global", "tool:read", false);
			await storage.update("global", "tool:read", undefined);
			expect(await storage.load()).toEqual({ global: {}, project: {} });
		} finally {
			await cleanup(directory);
		}
	});

	test("rejects malformed JSON, non-object sections, and non-boolean entries", async () => {
		const { directory, paths, storage } = await fixture();
		try {
			await writeFile(paths.globalPath, "{");
			await expect(storage.load()).rejects.toThrow("Invalid JSON");
			await writeFile(paths.globalPath, JSON.stringify({ "pi-basics-loadout": [] }));
			await expect(storage.load()).rejects.toThrow("object");
			await writeFile(
				paths.globalPath,
				JSON.stringify({ "pi-basics-loadout": { "tool:read": "yes" } }),
			);
			await expect(storage.load()).rejects.toThrow("tool:read");
			await expect(storage.update("global", "tool:read", undefined)).rejects.toThrow("boolean");
		} finally {
			await cleanup(directory);
		}
	});

	test("serializes concurrent updates per path with read-modify-write", async () => {
		const { directory, storage } = await fixture();
		try {
			await Promise.all([
				storage.update("global", "tool:read", true),
				storage.update("global", "tool:write", false),
				storage.update("global", "skill:librarian", true),
			]);
			expect((await storage.load()).global).toEqual({
				"tool:read": true,
				"tool:write": false,
				"skill:librarian": true,
			});
		} finally {
			await cleanup(directory);
		}
	});
});
