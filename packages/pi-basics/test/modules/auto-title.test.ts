import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	autoTitleModelOptions,
	createAutoTitleCoordinator,
	createAutoTitleSettingsProvider,
	createAutoTitleStorage,
	parseModelRef,
} from "../../src/modules/auto-title/index.js";

const context = (cwd: string) => ({ sessionId: "s", cwd });

describe("Pi Basics auto-title", () => {
	test("parses exact provider/model and preserves project packages", async () => {
		expect(parseModelRef("provider/model")).toEqual({ provider: "provider", model: "model" });
		expect(() => parseModelRef("provider/model/extra")).toThrow();
		const dir = await mkdtemp(join(tmpdir(), "pi-basics-title-"));
		try {
			const path = join(dir, ".pi", "settings.json");
			await Bun.write(path, JSON.stringify({ packages: ["npm:pi-subagents"], other: true }));
			const storage = createAutoTitleStorage({ path });
			await storage.save(
				{ "auto-title": { autoTitle: true, autoTitleModel: "provider/model" } },
				context(dir),
			);
			const root = JSON.parse(await readFile(path, "utf8"));
			expect(root.packages).toEqual(["npm:pi-subagents"]);
			expect(root["pi-basics"]["auto-title"].autoTitle).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("lists available models as selectable provider/model options", () => {
		expect(
			autoTitleModelOptions([
				{ provider: "openai", id: "gpt-5", name: "GPT-5" },
				{ provider: "anthropic", id: "claude-haiku", name: "Haiku" },
			]).map((option) => option.value),
		).toEqual(["", "anthropic/claude-haiku", "openai/gpt-5"]);
	});

	test("allows automatic titles without a configured title model", async () => {
		let persisted: string | undefined = "unexpected";
		const provider = createAutoTitleSettingsProvider({
			onPersisted: (model) => {
				persisted = model;
			},
		});
		await provider.onLoad?.(
			{ "auto-title": { autoTitle: true, autoTitleModel: "" } },
			context("/tmp"),
		);
		expect(persisted).toBeUndefined();
		await provider.onChange?.(
			{
				groupId: "auto-title",
				fieldId: "autoTitle",
				value: true,
				state: { "auto-title": { autoTitle: true, autoTitleModel: "" } },
			},
			context("/tmp"),
		);
	});

	test("skips model validation when automatic titles are disabled", async () => {
		let validations = 0;
		const provider = createAutoTitleSettingsProvider({
			validate: () => {
				validations++;
			},
		});
		await provider.onLoad?.(
			{ "auto-title": { autoTitle: false, autoTitleModel: "provider/model" } },
			context("/tmp"),
		);
		expect(validations).toBe(0);
	});

	test("rejects unavailable model before enabling automatic titles", async () => {
		const provider = createAutoTitleSettingsProvider({
			validate: () => {
				throw new Error("unavailable");
			},
		});
		await expect(
			provider.onChange?.(
				{
					groupId: "auto-title",
					fieldId: "autoTitle",
					value: true,
					state: { "auto-title": { autoTitle: true, autoTitleModel: "provider/model" } },
				},
				context("/tmp"),
			),
		).rejects.toThrow("unavailable");
	});

	test("runs one isolated title agent and records the attempt", async () => {
		const handlers = new Map<string, (value: unknown) => void>();
		let appended = 0;
		let created = 0;
		let aborted = 0;
		let releasePrompt: (() => void) | undefined;
		const promptDone = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		const pi = {
			events: {
				on: (channel: string, handler: (value: unknown) => void) => {
					handlers.set(channel, handler);
					return () => handlers.delete(channel);
				},
			},
			appendEntry: () => {
				appended++;
			},
			getSessionName: () => undefined,
			setSessionName: () => undefined,
		};
		const ctx = {
			sessionManager: {
				getEntries: () => [
					{ type: "message", message: { role: "user", content: "Independent title" } },
				],
				getSessionId: () => "s",
			},
			isIdle: () => true,
			ui: { notify: () => undefined },
		};
		const coordinator = createAutoTitleCoordinator(
			{ pi, ctx } as never,
			"provider/model",
			(_runtime, model) => {
				created++;
				expect(model).toBe("provider/model");
				return {
					prompt: async (prompt) => {
						expect(prompt).toBe("Independent title");
						await promptDone;
					},
					abort: () => {
						aborted++;
					},
					waitForIdle: async () => undefined,
					result: () => "unused",
				};
			},
		);

		coordinator.trigger();
		coordinator.trigger();
		expect(created).toBe(1);
		expect(appended).toBe(1);
		releasePrompt?.();
		await Bun.sleep(0);
		coordinator.dispose();
		expect(aborted).toBe(0);
	});

	test("applies a sanitized title from the isolated agent", async () => {
		const handlers = new Map<string, (value: unknown) => void>();
		let applied: string | undefined;
		const pi = {
			events: {
				on: (channel: string, handler: (value: unknown) => void) => {
					handlers.set(channel, handler);
					return () => handlers.delete(channel);
				},
			},
			appendEntry: () => undefined,
			getSessionName: () => applied,
			setSessionName: (name: string) => {
				applied = name;
			},
		};
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message", message: { role: "user", content: "Need title" } }],
				getSessionId: () => "s",
			},
			isIdle: () => true,
			ui: { notify: () => undefined },
		};
		const coordinator = createAutoTitleCoordinator({ pi, ctx } as never, "provider/model", () => ({
			prompt: async () => undefined,
			abort: () => undefined,
			waitForIdle: async () => undefined,
			result: () => "  My \n Session  ",
		}));

		handlers.get("agent_settled")?.({});
		expect(applied).toBeUndefined();
		coordinator.trigger();
		await Bun.sleep(0);
		expect(applied).toBe("My Session");
		coordinator.dispose();
	});
});
