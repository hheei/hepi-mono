import { describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionSettingsStorage } from "./storage.js";

describe("extension settings storage", () => {
	it("stores multiple providers in one shared file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-ext-settings-"));
		const filePath = join(dir, "ext-settings.json");

		try {
			const ctx = undefined as never;
			const first = createExtensionSettingsStorage(filePath, "first");
			const second = createExtensionSettingsStorage(filePath, "second");

			await Promise.all([
				first.save({ general: { enabled: true }, hidden: { names: ["alpha", "beta"] } }, ctx),
				second.save({ general: { mode: "compact" } }, ctx),
			]);

			expect(await first.load(ctx)).toEqual({
				general: { enabled: true },
				hidden: { names: ["alpha", "beta"] },
			});
			expect(await second.load(ctx)).toEqual({ general: { mode: "compact" } });

			const saved = JSON.parse(await readFile(filePath, "utf8"));
			expect(saved).toEqual({
				providers: {
					first: {
						state: { general: { enabled: true }, hidden: { names: ["alpha", "beta"] } },
					},
					second: { state: { general: { mode: "compact" } } },
				},
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("backs up malformed shared settings and starts empty", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-ext-settings-bad-"));
		const filePath = join(dir, "ext-settings.json");

		try {
			const messages: string[] = [];
			const ctx = {
				ui: { notify: (message: string) => messages.push(message) },
			} as never;
			const storage = createExtensionSettingsStorage(filePath, "first");

			await writeFile(filePath, "{bad json", "utf8");

			expect(await storage.load(ctx)).toBeUndefined();
			expect(messages[0]).toContain("Recovered malformed extension settings");
			expect((await readdir(dir)).some((name) => name.startsWith("ext-settings.json.bad-"))).toBe(
				true,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
