import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonSectionSettingsStorage } from "../../src/core/index.js";
import {
	convertInputText,
	createTraditionalToSimplifiedFeature,
	createTraditionalToSimplifiedSettingsProvider,
	traditionalToSimplifiedEnabled,
} from "../../src/t2s/index.js";

describe("traditional to simplified", () => {
	test("converts prose and the missing 甚麼 term", () => {
		expect(convertInputText("甚麼設定需要幫忙？")).toBe("什么设定需要帮忙？");
	});

	test("preserves inline and fenced code", () => {
		const input = "請看 `甚麼`\n```ts\n甚麼設定\n```\n最後設定";
		expect(convertInputText(input)).toBe("请看 `甚麼`\n```ts\n甚麼設定\n```\n最后设定");
	});

	test("registers one input handler across session restarts", () => {
		const handlers: Array<(event: { text: string }, ctx: unknown) => unknown> = [];
		let sessionId = "first";
		const runtime = {
			pi: {
				on: (event: string, handler: (event: { text: string }, ctx: unknown) => unknown) => {
					if (event === "input") handlers.push(handler);
				},
			},
			ctx: { sessionManager: { getSessionId: () => sessionId } },
		};
		const feature = createTraditionalToSimplifiedFeature();
		feature.start(runtime as never);
		feature.dispose("first");
		sessionId = "second";
		feature.start(runtime as never);

		expect(handlers).toHaveLength(1);
		const result = handlers[0]?.(
			{ text: "設定" },
			{ sessionManager: { getSessionId: () => "second" } },
		);
		expect(result).toEqual({ action: "transform", text: "设定" });
	});

	test("persists the toggle without discarding other settings", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-t2s-"));
		try {
			const provider = createTraditionalToSimplifiedSettingsProvider({ settingsDirectory: cwd });
			await provider.storage.save(
				{ "traditional-to-simplified": { mode: "off" } },
				{ sessionId: "test", cwd },
			);
			const loaded = await provider.storage.load({ sessionId: "test", cwd });
			expect(loaded?.["traditional-to-simplified"]?.mode).toBe("off");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("derives the runtime value only from settings loaded at session start", () => {
		expect(traditionalToSimplifiedEnabled({ "traditional-to-simplified": { mode: "off" } })).toBe(
			false,
		);
		expect(traditionalToSimplifiedEnabled({ "traditional-to-simplified": { mode: "t2s" } })).toBe(
			true,
		);
	});

	test("shares the settings write queue with other Pi Basics providers", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-t2s-concurrent-"));
		try {
			const t2s = createTraditionalToSimplifiedSettingsProvider({ settingsDirectory: cwd });
			const other = createJsonSectionSettingsStorage({
				path: join(cwd, "settings.json"),
				section: "pi-basics",
				group: "other",
			});
			await Promise.all([
				t2s.storage.save(
					{ "traditional-to-simplified": { mode: "off" } },
					{ sessionId: "t2s", cwd },
				),
				other.save({ other: { enabled: true } }, { sessionId: "other", cwd }),
			]);
			const saved = JSON.parse(await readFile(join(cwd, "settings.json"), "utf8"));
			expect(saved["pi-basics"]).toEqual({
				"traditional-to-simplified": { mode: "off" },
				other: { enabled: true },
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("rejects invalid persisted settings", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-t2s-invalid-"));
		try {
			const settingsDirectory = cwd;
			await mkdir(settingsDirectory, { recursive: true });
			const provider = createTraditionalToSimplifiedSettingsProvider({ settingsDirectory });
			for (const values of [
				{ mode: "disabled" },
				{ mode: "none" },
				{ enabled: false },
				{ mode: "t2s", enabled: true },
			]) {
				await Bun.write(
					join(settingsDirectory, "settings.json"),
					JSON.stringify({ "pi-basics": { "traditional-to-simplified": values } }),
				);
				await expect(provider.storage.load({ sessionId: "test", cwd })).rejects.toThrow();
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
