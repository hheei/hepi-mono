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

	test("applies completed or steered matching title and blocks manual title", () => {
		const handlers = new Map<string, (value: unknown) => void>();
		const pi = {
			events: {
				on: (channel: string, handler: (value: unknown) => void) => {
					handlers.set(channel, handler);
					return () => handlers.delete(channel);
				},
				emit: (channel: string, value: unknown) => {
					if (channel === "subagents:rpc:ping")
						handlers.get(
							`subagents:rpc:ping:reply:${(value as { requestId: string }).requestId}`,
						)?.({ success: true, data: { version: 2 } });
				},
			},
			appendEntry: () => undefined,
			getSessionName: () => undefined,
			setSessionName: (name: string) => {
				applied = name;
			},
		};
		let applied: string | undefined;
		const entries = [{ type: "message", message: { role: "user", content: "Need title" } }];
		const ctx = {
			sessionManager: {
				getEntries: () => entries,
				getSessionId: () => "s",
				getSessionName: () => undefined,
			},
			isIdle: () => true,
		};
		const coordinator = createAutoTitleCoordinator({ pi, ctx } as never, "provider/model");
		handlers.get("agent_settled")?.({});
		expect([...handlers.keys()].some((key) => key.startsWith("subagents:rpc:spawn:reply:"))).toBe(
			false,
		);
		coordinator.trigger();
		const spawn = [...handlers.keys()].find((key) => key.startsWith("subagents:rpc:spawn:reply:"));
		handlers.get(spawn!)?.({ success: true, data: { id: "child" } });
		handlers.get("subagents:completed")?.({
			id: "child",
			status: "steered",
			result: "  My \n Session  ",
		});
		expect(applied).toBe("My Session");
		coordinator.dispose();
	});
});
