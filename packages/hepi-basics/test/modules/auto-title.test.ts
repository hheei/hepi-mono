import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AUTO_TITLE_MODEL_FIELD,
	AUTO_TITLE_SYSTEM_PROMPT,
	autoTitleModelOptions,
	completedTitleText,
	createAutoTitleCoordinator,
	createAutoTitleSettingsProvider,
	createAutoTitleStorage,
	parseModelRef,
	renderTitleGenerationShimmer,
	safeTitle,
	TITLE_SHIMMER_FRAME_MS,
	TITLE_SHIMMER_LOOP_MS,
	TITLE_SHIMMER_STEP_CELLS,
	TITLE_SHIMMER_TRAVEL_CELLS,
	TITLE_SHIMMER_WINDOW_CELLS,
} from "../../src/auto-title/module.js";
import { createJsonSectionSettingsStorage } from "../../src/core/index.js";

const context = (cwd: string) => ({ sessionId: "s", cwd });
const LONG_SESSION_CONTEXT = "x".repeat(501);
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const titleResponse = (title: string): string => JSON.stringify({ title });
const titleMessage = (stopReason: AssistantMessage["stopReason"], text: string): AssistantMessage =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
	}) as unknown as AssistantMessage;

describe("Pi Basics auto-title", () => {
	test("parses exact provider/model and preserves global settings", async () => {
		expect(parseModelRef("provider/model")).toEqual({ provider: "provider", model: "model" });
		expect(() => parseModelRef("provider/model/extra")).toThrow();
		const dir = await mkdtemp(join(tmpdir(), "pi-basics-title-"));
		try {
			const path = join(dir, "settings.json");
			await Bun.write(path, JSON.stringify({ packages: ["npm:pi-subagents"], other: true }));
			const storage = createAutoTitleStorage({ path });
			await storage.save(
				{ "auto-title": { autoTitle: true, autoTitleModel: "provider/model" } },
				context(dir),
			);
			const root = JSON.parse(await readFile(path, "utf8"));
			expect(root.packages).toEqual(["npm:pi-subagents"]);
			expect(root.hepi["auto-title"].autoTitle).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("shares the settings write queue with other Pi Basics providers", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-basics-title-concurrent-"));
		try {
			const path = join(dir, "settings.json");
			const title = createAutoTitleStorage({ path });
			const other = createJsonSectionSettingsStorage({
				path,
				section: "hepi",
				group: "other",
			});
			await Promise.all([
				title.save({ "auto-title": { autoTitle: true } }, context(dir)),
				other.save({ other: { enabled: true } }, context(dir)),
			]);
			const root = JSON.parse(await readFile(path, "utf8"));
			expect(root.hepi).toEqual({
				"auto-title": { autoTitle: true },
				other: { enabled: true },
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("defines a searchable same-language title contract", () => {
		expect(AUTO_TITLE_SYSTEM_PROMPT).toContain("same language");
		expect(AUTO_TITLE_SYSTEM_PROMPT).toContain("2 to 6 words");
		expect(AUTO_TITLE_SYSTEM_PROMPT).toContain("searchable title");
		expect(AUTO_TITLE_SYSTEM_PROMPT).toContain("code identifiers");
		expect(AUTO_TITLE_SYSTEM_PROMPT).toContain('Return exactly one JSON object: {"title":"..."}');
		expect(AUTO_TITLE_SYSTEM_PROMPT).not.toContain("English only");
	});

	test("accepts only a title JSON object and enforces the title limit", () => {
		expect(safeTitle(titleResponse("修复 auto-title 策略。"))).toBe("修复 auto-title 策略");
		expect(safeTitle(titleResponse("Improve session search"))).toBe("Improve session search");
		expect(safeTitle(titleResponse("Fix cache"))).toBe("Fix cache");
		expect(safeTitle(titleResponse("x".repeat(80)))).toHaveLength(60);
		expect(safeTitle('Title: "Improve session search".')).toBeUndefined();
		expect(safeTitle('{"title":"Fix cache","reason":"brief"}')).toBeUndefined();
		expect(safeTitle("\n\n")).toBeUndefined();
	});

	test("uses title text only from a completed assistant message", () => {
		expect(completedTitleText([titleMessage("stop", "Fix title extraction")])).toBe(
			"Fix title extraction",
		);
		expect(
			completedTitleText([
				titleMessage("length", "We need answer title in Chinese. Need concise searchable 2-6"),
			]),
		).toBeUndefined();
		expect(completedTitleText([titleMessage("toolUse", "Unexpected tool call")])).toBeUndefined();
	});

	test("renders a two-second right-half greyscale shimmer for title generation", () => {
		const initial = renderTitleGenerationShimmer(0);
		const middle = renderTitleGenerationShimmer(1_500);
		expect(initial).toContain("\x1b[38;2;");
		expect(initial).toEndWith("\x1b[0m");
		expect(initial).not.toBe(middle);
		expect(initial.replace(ANSI_SGR, "")).toBe("Generating title");
		expect(renderTitleGenerationShimmer(0)).toBe(renderTitleGenerationShimmer(2_000));
		expect((TITLE_SHIMMER_LOOP_MS / TITLE_SHIMMER_FRAME_MS) * TITLE_SHIMMER_STEP_CELLS).toBe(
			TITLE_SHIMMER_TRAVEL_CELLS,
		);
		expect(TITLE_SHIMMER_FRAME_MS).toBe(100);
		expect(TITLE_SHIMMER_STEP_CELLS).toBeCloseTo(1.3, 3);
		expect(TITLE_SHIMMER_WINDOW_CELLS).toBe(4);
		const peakAtFourthCell = renderTitleGenerationShimmer(
			((4 + 5) / TITLE_SHIMMER_TRAVEL_CELLS) * TITLE_SHIMMER_LOOP_MS,
		);
		expect(peakAtFourthCell).toContain("\x1b[38;2;110;110;110me");
		expect(peakAtFourthCell).toContain("\x1b[38;2;255;255;255mr");
		expect(peakAtFourthCell).toContain("\x1b[38;2;110;110;110mn");
	});

	test("lists available models as selectable provider/model options", () => {
		const options = autoTitleModelOptions([
			{ provider: "openai", id: "gpt-5", name: "GPT-5" },
			{ provider: "anthropic", id: "claude-haiku", name: "Haiku" },
		]);
		expect(options.map((option) => option.value)).toEqual([
			"",
			"anthropic/claude-haiku",
			"openai/gpt-5",
		]);
		expect(options.map((option) => option.label)).toEqual([
			"Not set",
			"anthropic/claude-haiku",
			"openai/gpt-5",
		]);
	});

	test("uses the shared fixed-off title model selection", () => {
		const provider = createAutoTitleSettingsProvider({
			modelOptions: [{ value: "cx/gpt-5.6-luna", label: "cx/gpt-5.6-luna" }],
		});
		const field = provider.groups[0]?.fields.find(
			(candidate) => candidate.id === AUTO_TITLE_MODEL_FIELD,
		);
		expect(field?.tabCycle).toBeUndefined();
		expect(field?.formatDisplay?.("cx/gpt-5.6-luna")).toBe("○ cx/gpt-5.6-luna");
		expect(field?.formatDescription?.("cx/gpt-5.6-luna")).toBe("cx/gpt-5.6-luna off");
	});

	test("allows automatic titles without a configured title model", async () => {
		const provider = createAutoTitleSettingsProvider();
		await provider.onLoad?.(
			{ "auto-title": { autoTitle: true, autoTitleModel: "" } },
			context("/tmp"),
		);
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
					{ type: "message", message: { role: "assistant", content: "Initial result" } },
					{ type: "message", message: { role: "assistant", content: "noise".repeat(2000) } },
					{ type: "message", message: { role: "user", content: "Use pi-auto-title" } },
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
							`Primary user request:\n${LONG_SESSION_CONTEXT}\n\nFirst assistant result:\nInitial result\n\nLatest user clarification:\nUse pi-auto-title`,
						);
						expect(prompt).not.toContain("noise");
						await promptDone;
					},
					abort: () => {
						aborted++;
					},
					waitForIdle: async () => undefined,
					result: () => titleResponse("Generated title"),
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

	test("generates after the first settled turn with short context", async () => {
		const handlers = new Map<string, (value: unknown) => void>();
		const userText = "Fix login";
		const assistantText = "Updated button";
		const entries: Array<{
			type: "message";
			message: { role: "user" | "assistant"; content: unknown };
		}> = [];
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
				result: () => titleResponse("Fix mobile login button"),
			};
		});

		coordinator.trigger();
		expect(created).toBe(0);
		entries.push(
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
		);
		handlers.get("agent_settled")?.({});
		await Bun.sleep(0);

		expect(created).toBe(1);
		expect(generatedPrompt).toContain(`Primary user request:\n${userText}`);
		expect(generatedPrompt).toContain(`First assistant result:\n${assistantText}`);
		expect(generatedPrompt).not.toContain("Internal analysis");
		expect(applied).toBe("Fix mobile login button");
		coordinator.dispose();
	});

	test("manual trigger waits for idle and replaces an existing title with short context", async () => {
		const handlers = new Map<string, (value: unknown) => void>();
		let applied: string | undefined = "Old title";
		let idle = false;
		const statuses: Array<{ readonly key: string; readonly text: string | undefined }> = [];
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
				setStatus: (key: string, text: string | undefined) => {
					statuses.push({ key, text });
				},
			},
		};
		const coordinator = createAutoTitleCoordinator({ pi, ctx } as never, "provider/model", () => ({
			prompt: async () => undefined,
			abort: () => undefined,
			waitForIdle: async () => undefined,
			result: () => titleResponse("  My   Session  "),
		}));

		handlers.get("agent_settled")?.({});
		expect(applied).toBe("Old title");
		coordinator.trigger(true);
		expect(applied).toBe("Old title");
		idle = true;
		await Bun.sleep(200);
		expect(applied).toBe("My Session");
		expect(
			statuses.some((entry) => entry.text?.replace(ANSI_SGR, "").includes("Generating title")),
		).toBe(true);
		expect(statuses.at(-1)).toEqual({ key: "auto-title", text: undefined });
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

	test("retries after a title model returns an unusable result", async () => {
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
				result: () =>
					created === 1
						? "We need answer title in Chinese. Need concise searchable 2-6"
						: titleResponse("Retry title"),
			};
		});

		coordinator.trigger();
		await Bun.sleep(0);
		expect(created).toBe(1);
		expect(result).toBeUndefined();
		handlers.get("agent_settled")?.({});
		await Bun.sleep(0);
		expect(created).toBe(2);
		expect(result).toBe("Retry title");
		coordinator.dispose();
	});
});
