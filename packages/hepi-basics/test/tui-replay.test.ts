import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	type ReplayKey,
	replayTui,
	scrollbackLines,
	stripAnsi,
	viewFrame,
	writeReplayArtifacts,
} from "../../hepi-debug/src/tui-replay.js";
import { createStatusFeature } from "../src/core/contributions/status/index.js";
import { createStatusbarFeature } from "../src/core/contributions/statusbar/index.js";

const theme = {
	fg: (color: string, text: string) =>
		`\x1b[${color === "accent" ? 36 : color === "dim" ? 90 : 33}m${text}\x1b[0m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	dim: (text: string) => `\x1b[2m${text}\x1b[22m`,
	italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
	strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
} as unknown as Theme;

describe("tui replay", () => {
	test("replays composed statusbar editor rail through updates and resize", async () => {
		let modelName = "GPT";
		let thinking = "low";
		let title: string | undefined = "Session";
		let statuses: ReadonlyMap<string, string> | undefined;
		let usage: { percent: number | null; contextWindow: number | null } = {
			percent: 50,
			contextWindow: 1234,
		};
		let editorFactory:
			| NonNullable<Parameters<NonNullable<ExtensionContext["ui"]["setEditorComponent"]>>[0]>
			| undefined;
		let footerFactory:
			| NonNullable<Parameters<NonNullable<ExtensionContext["ui"]["setFooter"]>>[0]>
			| undefined;
		type EditorFactory = NonNullable<
			Parameters<NonNullable<ExtensionContext["ui"]["setEditorComponent"]>>[0]
		>;
		type Editor = ReturnType<EditorFactory>;
		editorFactory = (..._args): Editor => ({
			render: () => ["previous-top", "PROMPT HERE", "previous-bottom", "previous-autocomplete"],
			invalidate: () => undefined,
			getText: () => "",
			setText: () => undefined,
			handleInput: () => undefined,
		});
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
		const pi = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			getThinkingLevel: () => thinking,
		} as unknown as ExtensionAPI;
		const ctx = {
			mode: "tui",
			cwd: "/workspace/project",
			model: {
				id: "model",
				get name() {
					return modelName;
				},
			},
			getContextUsage: () => usage,
			sessionManager: { getSessionId: () => "replay", getSessionName: () => title },
			ui: {
				theme,
				getEditorComponent: () => editorFactory,
				setEditorComponent: (next: typeof editorFactory) => {
					editorFactory = next;
				},
				setFooter: (next: typeof footerFactory | undefined) => {
					footerFactory = next;
				},
			},
		} as unknown as ExtensionContext;
		const feature = createStatusbarFeature(pi);
		feature.start({
			pi,
			ctx,
			registry: {} as never,
			requestRender: () => undefined,
			close: () => undefined,
		});
		const footer = footerFactory!({ requestRender: () => undefined } as never, theme, {
			getExtensionStatuses: () => statuses ?? new Map(),
		} as never);
		expect(stripAnsi(footer.render(80)[0] ?? "")).toContain("/workspace/project");
		const baseFactory = editorFactory!;
		const result = await replayTui({
			columns: 80,
			rows: 4,
			create: (host) => {
				const editor = baseFactory({} as never, {} as never, {} as never);
				return {
					render: (width: number) => [...editor.render(width), ...footer.render(width)],
					handleInput(data: string) {
						if (data === "model") modelName = "Claude";
						if (data === "thinking") thinking = "xhigh";
						if (data === "status") {
							statuses = new Map([
								["goal", "Goal"],
								["advisor", "concern"],
							]);
							title = "Updated session";
						}
						if (data === "usage") usage = { percent: null, contextWindow: null };
						editor.handleInput?.(data);
						host.requestRender();
					},
				};
			},
			actions: [
				{ type: "input", data: "model", label: "model update" },
				{ type: "input", data: "thinking", label: "thinking update" },
				{ type: "resize", columns: 24, label: "resize 24" },
				{ type: "input", data: "status", label: "status update" },
				{ type: "resize", columns: 8, label: "resize 8" },
				{ type: "input", data: "usage", label: "unknown usage" },
				{ type: "resize", columns: 80, label: "resize 80" },
			],
		});
		expect(result.frames).toHaveLength(8);
		for (const [index, frame] of result.frames.entries()) {
			expect(frame.lines).toHaveLength(index < 4 ? 4 : 5);
			expect(frame.lines[0]).not.toBe("previous-top");
			expect(frame.lines[0]).not.toContain("\n");
			expect(stripAnsi(frame.lines[0]!)).toHaveLength(frame.columns);
			expect(stripAnsi(frame.lines[1]!)).toBe("PROMPT HERE");
			expect(stripAnsi(frame.lines[2]!)).toBe("previous-bottom");
			expect(stripAnsi(frame.lines[3]!)).toBe("previous-autocomplete");
		}
		expect(stripAnsi(result.frames[0]!.lines[0]!)).toContain("⣤⣤");
		expect(stripAnsi(result.frames[0]!.lines[0]!)).toContain("1.2k");
		expect(stripAnsi(result.frames[0]!.lines[0]!)).toContain("Session");
		expect(stripAnsi(result.frames[1]!.lines[0]!)).toContain("Claude");
		expect(stripAnsi(result.frames[2]!.lines[0]!)).toContain("●");
		expect(stripAnsi(result.frames[7]!.lines[0]!)).not.toContain("GOAL");
		expect(stripAnsi(result.frames[7]!.lines[0]!)).toContain("Claude ✦ ·");
		expect(stripAnsi(result.frames[7]!.lines[4]!)).toContain("GOAL");
		expect(stripAnsi(result.frames[7]!.lines[4]!)).not.toContain("Advisor");
		expect(stripAnsi(result.frames[7]!.lines[0]!)).toContain("?? ?");
		expect(result.frames[1]!.lines[0]).toContain("\x1b[");
		feature.dispose("replay");
	});
	test("replays response metrics immediately after assistant output", async () => {
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
		let statusText: Text | undefined;
		const pi = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			mode: "tui",
			sessionManager: { getSessionId: () => "status-replay" },
			ui: {
				notify(message: string) {
					statusText = new Text(theme.fg("dim", message), 1, 0);
				},
			},
		} as unknown as ExtensionContext;
		const emit = (event: string, value: unknown): void => {
			for (const handler of handlers.get(event) ?? []) void handler(value, ctx);
		};
		const message = {
			role: "assistant",
			usage: { input: 1_200, output: 50, cacheRead: 800, reasoning: 10 },
		};
		const feature = createStatusFeature(pi);
		feature.start({
			pi,
			ctx,
			registry: {} as never,
			requestRender: () => undefined,
			close: () => undefined,
		});
		const result = await replayTui({
			columns: 100,
			rows: 5,
			create: (host) => ({
				render(width) {
					return [
						"Assistant: implementation complete",
						...(statusText === undefined ? [] : ["", ...statusText.render(width)]),
						"PROMPT HERE",
					];
				},
				handleInput(data) {
					if (data === "start") {
						emit("agent_start", { type: "agent_start" });
						emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
					}
					if (data === "token")
						emit("message_update", {
							type: "message_update",
							message,
							assistantMessageEvent: { type: "text_delta", delta: "x" },
						});
					if (data === "end") {
						emit("message_end", { type: "message_end", message });
						emit("agent_end", { type: "agent_end", messages: [message] });
					}
					if (data === "settled") emit("agent_settled", { type: "agent_settled" });
					host.requestRender();
				},
				invalidate() {},
			}),
			actions: [
				{ type: "input", data: "start", label: "response start" },
				{ type: "wait", ms: 20, label: "response wait" },
				{ type: "input", data: "token", label: "first token" },
				{ type: "wait", ms: 40, label: "generation wait" },
				{ type: "input", data: "end", label: "response end" },
				{ type: "input", data: "settled", label: "response settled" },
			],
		});
		const ended = result.frames.find((frame) => frame.label === "response end");
		expect(stripAnsi(ended?.lines.join("\n") ?? "")).toContain("↱ 1.2K  ↳ 50  ⚇ 800  ⏱");
		expect(result.last.lines[0]).toBe("Assistant: implementation complete");
		expect(result.last.lines[1]).toBe("");
		expect(stripAnsi(result.last.lines[2]!)).toContain("↱ 1.2K  ↳ 50  ⚇ 800  ⏱");
		expect(result.last.lines[3]).toBe("PROMPT HERE");
		const artifactRoot = process.env.PI_BASICS_STATUS_REPLAY_OUTPUT;
		if (artifactRoot) {
			const artifacts = await writeReplayArtifacts(result, { rootDir: artifactRoot });
			console.log(`response status replay artifacts: ${artifacts.directory}`);
		}
		feature.dispose("status-replay");
	});

	test("keeps full scrollback and supports multi-round input and scrolling", async () => {
		let draft = "";
		const transcript = ["system"];
		const result = await replayTui({
			columns: 30,
			rows: 3,
			create: (host) => ({
				render: () => [...transcript, `> ${draft}`],
				handleInput(data) {
					if (data === "\r") {
						transcript.push(`user: ${draft}`, `assistant: ${transcript.length}`);
						draft = "";
					} else {
						draft += data;
					}
					host.requestRender();
				},
				invalidate() {},
			}),
			actions: [
				{ type: "text", text: "one" },
				{ type: "key", key: "enter" },
				{ type: "text", text: "two" },
				{ type: "key", key: "enter" },
			],
		});

		expect(result.frames).toHaveLength(5);
		expect(viewFrame(result.last)).toEqual(["user: two", "assistant: 3", "> "]);
		expect(scrollbackLines(result.last)).toEqual(["system", "user: one", "assistant: 1"]);
		expect(viewFrame(result.last, { scrollOffset: 2 })).toEqual([
			"user: one",
			"assistant: 1",
			"user: two",
		]);
		expect(viewFrame(result.last, { scrollOffset: 99 })).toEqual([
			"system",
			"user: one",
			"assistant: 1",
		]);
	});

	test("awaits input and maps named keys", async () => {
		const keys: readonly [ReplayKey, string][] = [
			["up", "\x1b[A"],
			["down", "\x1b[B"],
			["right", "\x1b[C"],
			["left", "\x1b[D"],
			["enter", "\r"],
			["escape", "\x1b"],
			["tab", "\t"],
			["shift-tab", "\x1b[Z"],
			["backspace", "\x7f"],
			["delete", "\x1b[3~"],
			["home", "\x1b[H"],
			["end", "\x1b[F"],
			["page-up", "\x1b[5~"],
			["page-down", "\x1b[6~"],
		];
		const received: string[] = [];
		const result = await replayTui({
			create: () => ({
				render: () => [String(received.length)],
				async handleInput(data) {
					await Promise.resolve();
					received.push(data);
				},
				invalidate() {},
			}),
			actions: keys.map(([key]) => ({ type: "key" as const, key })),
		});

		expect(received).toEqual(keys.map(([, input]) => input));
		expect(result.last.lines).toEqual([String(keys.length)]);
	});

	test("applies resize and wait validation and strips ANSI string controls", async () => {
		const result = await replayTui({
			columns: 10,
			rows: 2,
			create: (host) => ({
				render: () => [`${host.columns}x${host.rows}`],
				invalidate() {},
			}),
			actions: [
				{ type: "wait", ms: 0 },
				{ type: "resize", columns: 20, rows: 4 },
			],
		});
		expect(result.last).toMatchObject({ columns: 20, rows: 4, lines: ["20x4"] });
		expect(stripAnsi("a\x1bPsecret\x1b\\b\x1b^hidden\x1b\\c\x1bXprivate\x1b\\d")).toBe("abcd");
		await expect(
			replayTui({
				create: () => ({ render: () => [], invalidate() {} }),
				actions: [{ type: "wait", ms: -1 }],
			}),
		).rejects.toThrow("non-negative");
		await expect(
			replayTui({
				create: () => ({ render: () => [], invalidate() {} }),
				actions: [{ type: "resize", rows: 0 }],
			}),
		).rejects.toThrow("positive integer");
	});

	test("routes model actions with 50x35 luna-low defaults", async () => {
		let seen: unknown;
		const messages: string[] = [];
		const result = await replayTui({
			create: () => ({
				render: () => [...messages],
				handleModelResult(value) {
					messages.push(value.text);
				},
				invalidate() {},
			}),
			actions: [{ type: "model", prompt: "Actual prompt" }],
			runModel: async (request) => {
				seen = request;
				return { ...request, text: "model answer", events: [], stderr: "" };
			},
		});

		expect(result.frames[0]).toMatchObject({ columns: 50, rows: 35 });
		expect(seen).toEqual({
			prompt: "Actual prompt",
			model: "cx/gpt-5.6-luna",
			thinking: "low",
		});
		expect(result.modelResults[0]?.text).toBe("model answer");
		expect(result.last.lines).toEqual(["model answer"]);
	});

	test("writes sequentially numbered buffers and final SVG screenshot", async () => {
		const root = await mkdtemp(join(tmpdir(), "tui-replay-"));
		try {
			const result = await replayTui({
				columns: 12,
				rows: 3,
				create: () => ({
					render: () => [
						"\x1b]133;A\x07\x1b]8;;https://example.com\x1b\\\x1b[32m<&>\x1b]8;;\x1b\\",
						"still green\x1b[0m\x1b[2A",
						"final line",
					],
					invalidate() {},
				}),
			});
			const first = await writeReplayArtifacts(result, { rootDir: root });
			const second = await writeReplayArtifacts(result, { rootDir: root });

			expect(basename(first.directory)).toBe("replay-0001");
			expect(basename(second.directory)).toBe("replay-0002");
			expect((await readdir(first.directory)).sort()).toEqual([
				"final.ans",
				"final.svg",
				"final.txt",
				"metadata.json",
				"replay.ans",
				"replay.txt",
			]);
			expect(await readFile(first.finalPlain, "utf8")).toBe("<&>\nstill green\nfinal line\n");
			const finalAns = await readFile(first.finalAnsi, "utf8");
			expect(finalAns).toContain("\x1b[32m<&>\nstill green\x1b[0m");
			expect(finalAns).not.toContain("\x1b]133;");
			expect(finalAns).not.toContain("\x1b]8;;");
			expect(finalAns).not.toContain("\x1b[2A");
			const svg = await readFile(first.finalScreenshot, "utf8");
			expect(svg).toContain('width="125"');
			expect(svg).toContain("&lt;&amp;&gt;");
			expect(svg).toContain('fill="#13a10e"');
			expect(svg).toContain('fill="#13a10e">still green');
			expect(JSON.parse(await readFile(first.metadata, "utf8"))).toMatchObject({
				buffer: "component.render viewport",
				columns: 12,
				rows: 3,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
