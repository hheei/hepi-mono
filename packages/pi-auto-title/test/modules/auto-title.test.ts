import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonSectionSettingsStorage } from "@hheei/pi-basics";
import {
	AUTO_TITLE_SYSTEM_PROMPT,
	autoTitleModelOptions,
	createAutoTitleCoordinator,
	createAutoTitleSettingsProvider,
	createAutoTitleStorage,
	parseModelRef,
} from "../../src/module.js";

const context = (cwd: string) => ({ sessionId: "s", cwd });
const LONG_SESSION_CONTEXT = "x".repeat(501);

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

	test("shares the settings write queue with other Pi Basics providers", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-basics-title-concurrent-"));
		try {
			const title = createAutoTitleStorage();
			const other = createJsonSectionSettingsStorage({ section: "pi-basics", group: "other" });
			await Promise.all([
				title.save({ "auto-title": { autoTitle: true } }, context(dir)),
				other.save({ other: { enabled: true } }, context(dir)),
			]);
			const root = JSON.parse(await readFile(join(dir, ".pi", "settings.json"), "utf8"));
			expect(root["pi-basics"]).toEqual({
				"auto-title": { autoTitle: true },
				other: { enabled: true },
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("defines a concise plain-text title contract", () => {
		expect(AUTO_TITLE_SYSTEM_PROMPT).toContain("no more than 6 words");
		expect(AUTO_TITLE_SYSTEM_PROMPT).toContain("English only");
		expect(AUTO_TITLE_SYSTEM_PROMPT).toContain("Use sentence case");
		expect(AUTO_TITLE_SYSTEM_PROMPT).toContain("Return only the title as plain text");
		expect(AUTO_TITLE_SYSTEM_PROMPT).not.toContain("branch");
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

	test("leaves host handler ownership to the extension", () => {
		let registrations = 0;
		const coordinator = createAutoTitleCoordinator(
			{
				pi: {
					on: () => {
						registrations++;
					},
					appendEntry: () => undefined,
					getSessionName: () => undefined,
					setSessionName: () => undefined,
				},
				ctx: {
					sessionManager: { getEntries: () => [], getSessionId: () => "s" },
					isIdle: () => true,
					ui: { notify: () => undefined },
				},
			} as never,
			"provider/model",
		);

		expect(registrations).toBe(0);
		coordinator.dispose();
	});

	test("runs one isolated title agent and records completion after setting title", async () => {
		const handlers = new Map<string, (value: unknown) => void>();
		let appended = 0;
		const entries: Array<{ type: string; customType?: string }> = [];
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
			appendEntry: (customType: string) => {
				appended++;
				entries.push({ type: "custom", customType });
			},
			getSessionName: () => undefined,
			setSessionName: () => undefined,
		};
		const ctx = {
			sessionManager: {
				getEntries: () => [
					{ type: "message", message: { role: "user", content: LONG_SESSION_CONTEXT } },
					...entries,
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
						expect(prompt).toBe(
							`Session transcript:\n\nUser: ${LONG_SESSION_CONTEXT.slice(0, 500)}`,
						);
						await promptDone;
					},
					abort: () => {
						aborted++;
					},
					waitForIdle: async () => undefined,
					result: () => "Generated title",
				};
			},
		);

		coordinator.trigger();
		coordinator.trigger();
		expect(created).toBe(1);
		expect(appended).toBe(0);
		releasePrompt?.();
		await Bun.sleep(0);
		expect(appended).toBe(1);
		coordinator.dispose();
		const reloaded = createAutoTitleCoordinator({ pi, ctx } as never, "provider/model", () => {
			created++;
			throw new Error("should not retry completed title");
		});
		reloaded.trigger();
		expect(created).toBe(1);
		reloaded.dispose();
		expect(aborted).toBe(0);
	});

	test("requires more than 500 user and assistant characters", async () => {
		const handlers = new Map<string, (value: unknown) => void>();
		const userText = "u".repeat(250);
		const assistantText = "a".repeat(250);
		const entries: Array<{
			type: "message";
			message: { role: "user" | "assistant"; content: unknown };
		}> = [
			{ type: "message", message: { role: "user", content: userText } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Internal analysis" },
						{ type: "text", text: assistantText },
					],
				},
			},
		];
		let created = 0;
		let generatedPrompt: string | undefined;
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
				getEntries: () => entries,
				getSessionId: () => "s",
			},
			isIdle: () => true,
			ui: { notify: () => undefined },
		};
		const coordinator = createAutoTitleCoordinator({ pi, ctx } as never, "provider/model", () => {
			created++;
			return {
				prompt: async (prompt) => {
					generatedPrompt = prompt;
				},
				abort: () => undefined,
				waitForIdle: async () => undefined,
				result: () => "Fix mobile login button",
			};
		});

		coordinator.trigger();
		expect(created).toBe(0);
		entries.push({ type: "message", message: { role: "assistant", content: "b" } });
		handlers.get("agent_settled")?.({});
		await Bun.sleep(0);

		expect(created).toBe(1);
		expect(generatedPrompt).toContain(`User: ${userText}`);
		expect(generatedPrompt).toContain(`Assistant: ${assistantText}`);
		expect(generatedPrompt).toContain("Assistant: b");
		expect(generatedPrompt).not.toContain("Internal analysis");
		expect(applied).toBe("Fix mobile login button");
		coordinator.dispose();
	});

	test("triggers on the third user turn below 500 characters", async () => {
		const handlers = new Map<string, (value: unknown) => void>();
		const entries: Array<{
			type: "message";
			message: { role: "user" | "assistant"; content: string };
		}> = [
			{ type: "message", message: { role: "user", content: "First" } },
			{ type: "message", message: { role: "assistant", content: "First response" } },
			{ type: "message", message: { role: "user", content: "Second" } },
			{ type: "message", message: { role: "assistant", content: "Second response" } },
		];
		let created = 0;
		const pi = {
			events: {
				on: (channel: string, handler: (value: unknown) => void) => {
					handlers.set(channel, handler);
					return () => handlers.delete(channel);
				},
			},
			appendEntry: () => undefined,
			getSessionName: () => undefined,
			setSessionName: () => undefined,
		};
		const ctx = {
			sessionManager: {
				getEntries: () => entries,
				getSessionId: () => "s",
			},
			isIdle: () => true,
			ui: { notify: () => undefined },
		};
		const coordinator = createAutoTitleCoordinator({ pi, ctx } as never, "provider/model", () => {
			created++;
			return {
				prompt: async () => undefined,
				abort: () => undefined,
				waitForIdle: async () => undefined,
				result: () => "Third turn title",
			};
		});

		coordinator.trigger();
		expect(created).toBe(0);
		entries.push(
			{ type: "message", message: { role: "user", content: "Third" } },
			{ type: "message", message: { role: "assistant", content: "Third response" } },
		);
		handlers.get("agent_settled")?.({});
		await Bun.sleep(0);

		expect(created).toBe(1);
		coordinator.dispose();
	});

	test("manual trigger waits for idle and replaces an existing title with short context", async () => {
		const handlers = new Map<string, (value: unknown) => void>();
		let applied: string | undefined = "Old title";
		let idle = false;
		const widgets: Array<{ readonly content: unknown; readonly options: unknown }> = [];
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
				getEntries: () => [
					{ type: "message", message: { role: "user", content: "Fix the parser" } },
				],
				getSessionId: () => "s",
			},
			isIdle: () => idle,
			ui: {
				notify: () => undefined,
				setWidget: (_key: string, content: unknown, options: unknown) => {
					widgets.push({ content, options });
				},
			},
		};
		const coordinator = createAutoTitleCoordinator({ pi, ctx } as never, "provider/model", () => ({
			prompt: async () => undefined,
			abort: () => undefined,
			waitForIdle: async () => undefined,
			result: () => "  My \n Session  ",
		}));

		handlers.get("agent_settled")?.({});
		expect(applied).toBe("Old title");
		coordinator.trigger(true);
		expect(applied).toBe("Old title");
		idle = true;
		await Bun.sleep(200);
		expect(applied).toBe("My Session");
		expect(widgets.some((entry) => String(entry.content).includes("Generating title"))).toBe(true);
		expect(widgets.at(-1)).toEqual({ content: undefined, options: { placement: "aboveEditor" } });
		coordinator.dispose();
	});

	test("retries after failure with a reloaded coordinator", async () => {
		const entries: Array<{ type: string; customType?: string }> = [];
		const handlers = new Map<string, (value: unknown) => void>();
		let created = 0;
		const pi = {
			events: {
				on: (channel: string, handler: (value: unknown) => void) => {
					handlers.set(channel, handler);
					return () => handlers.delete(channel);
				},
			},
			appendEntry: (customType: string) => entries.push({ type: "custom", customType }),
			getSessionName: () => undefined,
			setSessionName: () => undefined,
		};
		const ctx = {
			sessionManager: {
				getEntries: () => [
					{ type: "message", message: { role: "user", content: LONG_SESSION_CONTEXT } },
					...entries,
				],
				getSessionId: () => "s",
			},
			isIdle: () => true,
			ui: { notify: () => undefined },
		};
		const createAgent = () => {
			created++;
			return {
				prompt: async () => {
					throw new Error("failed");
				},
				abort: () => undefined,
				waitForIdle: async () => undefined,
				result: () => undefined,
			};
		};

		const first = createAutoTitleCoordinator({ pi, ctx } as never, "provider/model", createAgent);
		first.trigger();
		await Bun.sleep(0);
		first.dispose();
		expect(created).toBe(1);
		expect(entries).toEqual([]);

		const second = createAutoTitleCoordinator({ pi, ctx } as never, "provider/model", createAgent);
		second.trigger();
		await Bun.sleep(0);
		expect(created).toBe(2);
		second.dispose();
	});

	test("retries after a title model returns an empty result", async () => {
		const handlers = new Map<string, (value: unknown) => void>();
		let created = 0;
		let result: string | undefined;
		const pi = {
			events: {
				on: (channel: string, handler: (value: unknown) => void) => {
					handlers.set(channel, handler);
					return () => handlers.delete(channel);
				},
			},
			appendEntry: () => undefined,
			getSessionName: () => result,
			setSessionName: (name: string) => {
				result = name;
			},
		};
		const ctx = {
			sessionManager: {
				getEntries: () => [
					{ type: "message", message: { role: "user", content: LONG_SESSION_CONTEXT } },
				],
				getSessionId: () => "s",
			},
			isIdle: () => true,
			ui: { notify: () => undefined },
		};
		const coordinator = createAutoTitleCoordinator({ pi, ctx } as never, "provider/model", () => {
			created++;
			return {
				prompt: async () => undefined,
				abort: () => undefined,
				waitForIdle: async () => undefined,
				result: () => (created === 1 ? "" : "Retry title"),
			};
		});

		coordinator.trigger();
		await Bun.sleep(0);
		expect(created).toBe(1);
		handlers.get("agent_settled")?.({});
		await Bun.sleep(0);
		expect(created).toBe(2);
		expect(result).toBe("Retry title");
		coordinator.dispose();
	});
});
