import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultPiSettingsPaths,
	readJsonSettingsRoot,
	readJsonSettingsSection,
	updateJsonSettingsRoot,
} from "../src/index.js";

async function withDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-ext-core-settings-"));
	try {
		return await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("resolves Pi settings paths", (): void => {
	expect(defaultPiSettingsPaths("/project", "/agent")).toEqual({
		globalPath: "/agent/settings.json",
		projectPath: "/project/.pi/settings.json",
	});
});

test("reads opaque named settings sections", async (): Promise<void> => {
	await withDirectory(async (directory) => {
		const path = join(directory, "settings.json");
		await writeFile(path, JSON.stringify({ "pi-example": { nested: { future: true } } }), "utf8");
		expect(await readJsonSettingsSection(path, "pi-example")).toEqual({
			nested: { future: true },
		});
		expect(await readJsonSettingsSection(path, "missing")).toBeUndefined();
	});
});

test("rejects non-object settings roots and sections", async (): Promise<void> => {
	await withDirectory(async (directory) => {
		const path = join(directory, "settings.json");
		await writeFile(path, "[]", "utf8");
		await expect(readJsonSettingsRoot(path)).rejects.toThrow("Expected JSON object root");
		await writeFile(path, JSON.stringify({ "pi-example": [] }), "utf8");
		await expect(readJsonSettingsSection(path, "pi-example")).rejects.toThrow(
			"Expected pi-example to be an object",
		);
	});
});

test("serializes updates without replacing sibling settings", async (): Promise<void> => {
	await withDirectory(async (directory) => {
		const path = join(directory, "settings.json");
		await writeFile(path, JSON.stringify({ sibling: { retained: true } }), "utf8");
		await Promise.all([
			updateJsonSettingsRoot(path, (root) => {
				root.first = { enabled: true };
			}),
			updateJsonSettingsRoot(path, (root) => {
				root.second = { enabled: true };
			}),
		]);
		expect(await readJsonSettingsRoot(path)).toEqual({
			sibling: { retained: true },
			first: { enabled: true },
			second: { enabled: true },
		});
	});
});
