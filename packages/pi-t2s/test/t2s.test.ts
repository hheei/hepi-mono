import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateJsonSettingsRoot } from "@hheei/pi-ext-core";
import { convertInputText } from "../src/model.js";
import {
	createTraditionalToSimplifiedSettingsProvider,
	traditionalToSimplifiedEnabled,
} from "../src/settings.js";

describe("traditional to simplified model", () => {
	test("converts prose and the missing 甚麼 term", () => {
		expect(convertInputText("甚麼設定需要幫忙？")).toBe("什么设定需要帮忙？");
	});

	test("preserves inline and fenced code", () => {
		const input = "請看 `甚麼`\n```ts\n甚麼設定\n```\n~~~txt\n最後設定\n~~~\n最後設定";
		expect(convertInputText(input)).toBe(
			"请看 `甚麼`\n```ts\n甚麼設定\n```\n~~~txt\n最後設定\n~~~\n最后设定",
		);
	});
});

describe("traditional to simplified settings", () => {
	test("describes a reload-only provider and defaults to enabled", () => {
		const provider = createTraditionalToSimplifiedSettingsProvider({
			path: "/missing/settings.json",
		});
		expect(provider.id).toBe("pi-t2s");
		expect(provider.origin).toBe("@hheei/pi-t2s");
		expect(provider.onChange).toBeUndefined();
		expect(provider.groups[0]?.fields[0]?.defaultValue).toBe("t2s");
		expect(traditionalToSimplifiedEnabled({})).toBe(true);
		expect(traditionalToSimplifiedEnabled({ "traditional-to-simplified": { mode: "off" } })).toBe(
			false,
		);
	});

	test("loads and saves the owned section without discarding siblings", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-t2s-settings-"));
		const path = join(cwd, "settings.json");
		try {
			await Bun.write(
				path,
				JSON.stringify({
					"pi-t2s": { "traditional-to-simplified": { mode: "off" }, sibling: { kept: true } },
					rootSibling: { kept: true },
				}),
			);
			const provider = createTraditionalToSimplifiedSettingsProvider({ path });
			expect(
				(await provider.storage.load({ sessionId: "s" }))?.["traditional-to-simplified"],
			).toEqual({ mode: "off" });
			await provider.storage.save(
				{ "traditional-to-simplified": { mode: "t2s" } },
				{ sessionId: "s" },
			);
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				"pi-t2s": { "traditional-to-simplified": { mode: "t2s" }, sibling: { kept: true } },
				rootSibling: { kept: true },
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("atomically moves the legacy group while preserving every sibling", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-t2s-migrate-"));
		const path = join(cwd, "settings.json");
		try {
			await Bun.write(
				path,
				JSON.stringify({
					"pi-basics": {
						"traditional-to-simplified": { mode: "off" },
						retry: { enabled: true },
					},
					rootSibling: 1,
				}),
			);
			const provider = createTraditionalToSimplifiedSettingsProvider({ path });
			expect(
				(await provider.storage.load({ sessionId: "s" }))?.["traditional-to-simplified"],
			).toEqual({ mode: "off" });
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				"pi-basics": { retry: { enabled: true } },
				"pi-t2s": { "traditional-to-simplified": { mode: "off" } },
				rootSibling: 1,
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("prefers an existing owned section without touching legacy data", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-t2s-owned-"));
		const path = join(cwd, "settings.json");
		const root = {
			"pi-basics": { "traditional-to-simplified": { mode: "off" } },
			"pi-t2s": { "traditional-to-simplified": { mode: "t2s" } },
		};
		try {
			await Bun.write(path, JSON.stringify(root));
			const provider = createTraditionalToSimplifiedSettingsProvider({ path });
			expect(
				(await provider.storage.load({ sessionId: "s" }))?.["traditional-to-simplified"],
			).toEqual({ mode: "t2s" });
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual(root);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("rejects invalid owned and legacy settings", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-t2s-invalid-"));
		const path = join(cwd, "settings.json");
		try {
			await mkdir(cwd, { recursive: true });
			const provider = createTraditionalToSimplifiedSettingsProvider({ path });
			for (const root of [
				{ "pi-t2s": { "traditional-to-simplified": { mode: "disabled" } } },
				{ "pi-t2s": { "traditional-to-simplified": { mode: "t2s", extra: true } } },
				{ "pi-basics": { "traditional-to-simplified": { enabled: true } } },
			]) {
				await Bun.write(path, JSON.stringify(root));
				await expect(provider.storage.load({ sessionId: "s" })).rejects.toThrow();
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("shares the ext-core write queue with sibling providers", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-t2s-concurrent-"));
		const path = join(cwd, "settings.json");
		try {
			const provider = createTraditionalToSimplifiedSettingsProvider({ path });
			await Promise.all([
				provider.storage.save(
					{ "traditional-to-simplified": { mode: "off" } },
					{ sessionId: "t2s" },
				),
				updateJsonSettingsRoot(path, (root) => {
					root.sibling = { kept: true };
				}),
			]);
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				"pi-t2s": { "traditional-to-simplified": { mode: "off" } },
				sibling: { kept: true },
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
