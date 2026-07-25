import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

describe("JSON settings updates", () => {
	test("serializes read-modify-write across processes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-basics-json-settings-"));
		const settingsPath = join(directory, "settings.json");
		const moduleUrl = pathToFileURL(
			resolve(import.meta.dir, "../../src/runtime/json-settings.ts"),
		).href;
		const script = `
			const { updateJsonSettingsRoot } = await import(process.env.HEPI_SETTINGS_MODULE);
			await updateJsonSettingsRoot(process.env.HEPI_SETTINGS_PATH, (root) => {
				root[process.env.HEPI_SETTINGS_KEY] = { enabled: true };
			});
		`;
		const keys = Array.from({ length: 20 }, (_, index) => `writer-${index}`);
		const children = keys.map((key) =>
			Bun.spawn([process.execPath, "-e", script], {
				env: {
					...process.env,
					HEPI_SETTINGS_KEY: key,
					HEPI_SETTINGS_MODULE: moduleUrl,
					HEPI_SETTINGS_PATH: settingsPath,
				},
				stdout: "pipe",
				stderr: "pipe",
			}),
		);

		expect(await Promise.all(children.map((child) => child.exited))).toEqual(keys.map(() => 0));
		const root: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
		expect(root).toEqual(Object.fromEntries(keys.map((key) => [key, { enabled: true }])));
		expect(await readdir(directory)).toEqual(["settings.json"]);
	});

	test("uses PI_CODING_AGENT_DIR for default global storage", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-basics-agent-dir-"));
		const settingsPath = join(directory, "settings.json");
		const moduleUrl = pathToFileURL(
			resolve(import.meta.dir, "../../src/runtime/json-settings.ts"),
		).href;
		const script = `
			const { createJsonSectionSettingsStorage } = await import(process.env.HEPI_SETTINGS_MODULE);
			const storage = createJsonSectionSettingsStorage({ section: "pi-basics", group: "test" });
			await storage.save({ test: { enabled: true } }, { sessionId: "test", cwd: "/ignored" });
		`;
		const child = Bun.spawn([process.execPath, "-e", script], {
			env: {
				...process.env,
				HEPI_SETTINGS_MODULE: moduleUrl,
				PI_CODING_AGENT_DIR: directory,
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(await child.exited).toBe(0);
		const root: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
		expect(root).toEqual({ "pi-basics": { test: { enabled: true } } });
		expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
	});
});
