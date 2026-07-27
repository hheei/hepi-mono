import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { createStatusbarFeature } from "../../../src/core/contributions/statusbar/index.js";

type EditorFactory = NonNullable<
	Parameters<NonNullable<ExtensionContext["ui"]["setEditorComponent"]>>[0]
>;
type Editor = ReturnType<EditorFactory>;
type EditorArgs = Parameters<EditorFactory>;
type FooterFactory = NonNullable<Parameters<NonNullable<ExtensionContext["ui"]["setFooter"]>>[0]>;
type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function editorFactory(label: string, calls: string[]): EditorFactory {
	return (..._args: EditorArgs): Editor => ({
		render: () => [`${label}-top`, "PROMPT HERE", `${label}-bottom`, `${label}-autocomplete`],
		invalidate: () => undefined,
		getText: () => `${label}-text`,
		setText: () => undefined,
		handleInput: (data: string) => calls.push(`${label}:input:${data}`),
	});
}

function harness(id: string, mode: "tui" | "json" = "tui", hasEditorGetter = true) {
	let currentId = id;
	let usage: { tokens: number | null; percent: number | null; contextWindow: number } = {
		tokens: 12_000,
		percent: 12,
		contextWindow: 100_000,
	};
	let branch: unknown[] = [];
	let factory: FooterFactory | undefined;
	let footerComponent: { dispose?: () => void } | undefined;
	let installs = 0;
	let restored = 0;
	let editorFactory: EditorFactory | undefined;
	let editorSets = 0;
	const handlers = new Map<string, EventHandler[]>();
	const statusMap = new Map<string, string>();
	let statusReads = 0;
	let requests = 0;
	const pi = {
		on(event: string, handler: EventHandler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getThinkingLevel: () => "low" as const,
	} as unknown as ExtensionAPI;
	const ctx = {
		mode,
		model: { id: "model", name: "Model" },
		getContextUsage: () => usage,
		getSystemPrompt: () => "s".repeat(400),
		sessionManager: {
			getSessionId: () => currentId,
			getSessionName: () => "Title",
			getBranch: () => branch,
		},
		ui: {
			theme: { fg: (_role: string, text: string) => text },
			getEditorComponent: hasEditorGetter ? () => editorFactory : undefined,
			setEditorComponent: (next: EditorFactory | undefined) => {
				editorFactory = next;
				editorSets++;
			},
			setFooter: (next: FooterFactory | undefined) => {
				footerComponent?.dispose?.();
				footerComponent = undefined;
				if (next) {
					factory = next;
					installs++;
				} else restored++;
			},
		},
	} as unknown as ExtensionContext;
	return {
		pi,
		ctx,
		statusMap,
		setId(next: string) {
			currentId = next;
		},
		setEditor(next: EditorFactory | undefined) {
			editorFactory = next;
		},
		setUsage(next: typeof usage) {
			usage = next;
		},
		setBranch(next: unknown[]) {
			branch = next;
		},
		get editorFactory() {
			return editorFactory;
		},
		get factory() {
			return factory;
		},
		get installs() {
			return installs;
		},
		get restored() {
			return restored;
		},
		get editorSets() {
			return editorSets;
		},
		get requests() {
			return requests;
		},
		get statusReads() {
			return statusReads;
		},
		emit(event: string, eventCtx = ctx) {
			for (const handler of handlers.get(event) ?? []) void handler({}, eventCtx);
		},
		emitValue(event: string, value: unknown, eventCtx = ctx) {
			for (const handler of handlers.get(event) ?? []) void handler(value, eventCtx);
		},
		makeFooter() {
			if (!factory) throw new Error("footer factory not installed");
			const tui = {
				requestRender() {
					if (this !== tui) throw new Error("requestRender called without owning TUI");
					requests++;
				},
			};
			const component = factory(
				tui as never,
				{ fg: (_role: string, text: string) => text } as never,
				{
					getExtensionStatuses: () => {
						statusReads++;
						return statusMap;
					},
				} as never,
			);
			footerComponent = component;
			return component;
		},
		resetExtensionUi() {
			ctx.ui.setFooter(undefined);
			ctx.ui.setEditorComponent(undefined);
		},
	};
}

const runtime = (pi: ExtensionAPI, ctx: ExtensionContext) => ({
	pi,
	ctx,
	registry: {} as never,
	requestRender: () => undefined,
	close: () => undefined,
});

describe("statusbar lifecycle", () => {
	test("registers handlers once and factory reads current values", () => {
		const h = harness("a");
		const feature = createStatusbarFeature(h.pi);
		feature.start(runtime(h.pi, h.ctx));
		feature.start(runtime(h.pi, h.ctx));
		expect(h.installs).toBe(1);
		expect(h.makeFooter().render(100)).toEqual([]);
	});

	test("editor rail replaces only first line and delegates editor behavior", () => {
		const h = harness("a");
		const calls: string[] = [];
		h.setEditor(editorFactory("previous", calls));
		const feature = createStatusbarFeature(h.pi);
		feature.start(runtime(h.pi, h.ctx));
		h.makeFooter();
		const editor = h.editorFactory?.({} as never, {} as never, {} as never);
		expect(editor).toBeDefined();
		const lines = editor!.render(80);
		expect(lines).toHaveLength(4);
		expect(lines[0]).not.toBe("previous-top");
		expect(lines.slice(1)).toEqual(["PROMPT HERE", "previous-bottom", "previous-autocomplete"]);
		expect(h.statusReads).toBe(1);
		editor!.handleInput("x");
		expect(editor!.getText()).toBe("previous-text");
		expect(calls).toEqual(["previous:input:x"]);
	});

	test("renders compact animated statuses after the editor closing rail", async () => {
		const h = harness("a");
		h.statusMap.set("mcp", "MCP: 0/3 servers");
		h.statusMap.set("magic-context", "mc: 85.3K (23%) · idle");
		h.statusMap.set("retry", "receiving");
		h.statusMap.set("plan", "plan");
		h.statusMap.set("goal", "Goal");
		h.statusMap.set("advisor", "concern");
		h.setEditor(editorFactory("previous", []));
		const feature = createStatusbarFeature(h.pi);
		feature.start(runtime(h.pi, h.ctx));
		const footer = h.makeFooter();
		const editor = h.editorFactory?.({} as never, {} as never, {} as never);
		const editorLines = editor?.render(100) ?? [];
		const header = editorLines[0] ?? "";
		expect(header).not.toContain("MCP:");
		expect(header).not.toContain("mc:");
		expect(header).not.toContain("receiving");
		expect(header).toContain("Model ✦ ·");
		expect(editorLines[2]).toBe("previous-bottom");
		const footerLines = footer.render(100);
		expect(footerLines).toHaveLength(1);
		expect(footerLines[0]).toContain("⠋ · ⛁ 0/3 · PLAN · GOAL");
		expect(footerLines[0]).not.toContain("mc:");
		expect(footerLines[0]).not.toContain("concern");
		expect(h.statusReads).toBe(2);
		const beforeAnimation = h.requests;
		await Bun.sleep(120);
		expect(h.requests).toBeGreaterThan(beforeAnimation);
		feature.dispose("a");
		h.resetExtensionUi();
		const afterDispose = h.requests;
		await Bun.sleep(120);
		expect(h.requests).toBe(afterDispose);
	});

	test("keeps prompt text intact for the hardware cursor", () => {
		const h = harness("a");
		const previous = editorFactory("previous", []);
		h.setEditor((...args) => {
			const editor = previous(...args);
			return {
				...editor,
				render: () => [
					"previous-top",
					`end${CURSOR_MARKER}\x1b[7m \x1b[0m`,
					`middle${CURSOR_MARKER}\x1b[7m字\x1b[0mtext`,
				],
			};
		});
		const feature = createStatusbarFeature(h.pi);
		feature.start(runtime(h.pi, h.ctx));
		const editor = h.editorFactory?.({} as never, {} as never, {} as never);
		expect(editor!.render(80).slice(1)).toEqual([
			`end${CURSOR_MARKER} `,
			`middle${CURSOR_MARKER}字text`,
		]);
	});

	test("writes the configured hardware cursor style after rendering", async () => {
		const h = harness("a");
		h.setEditor(editorFactory("previous", []));
		const writes: string[] = [];
		const hardwareCursor: boolean[] = [];
		let visible = false;
		const setShowHardwareCursor = (value: boolean): void => {
			visible = value;
			hardwareCursor.push(value);
		};
		const feature = createStatusbarFeature(h.pi, () => ({ shape: "bar", blink: true }));
		feature.start(runtime(h.pi, h.ctx));
		const editor = h.editorFactory?.(
			{
				terminal: { write: (value: string) => writes.push(value) },
				getShowHardwareCursor: () => visible,
				setShowHardwareCursor,
			} as never,
			{} as never,
			{} as never,
		);
		setShowHardwareCursor(false);
		editor?.render(80);
		expect(writes).toEqual([]);
		await Promise.resolve();
		expect(writes).toEqual(["\x1b[5 q"]);
		feature.dispose("a");
		expect(writes).toEqual(["\x1b[5 q", "\x1b[0 q"]);
		expect(hardwareCursor).toEqual([true, false, true, false]);
	});

	test("stabilizes first-turn and post-compaction token transitions", () => {
		const h = harness("a");
		h.setEditor(editorFactory("previous", []));
		const feature = createStatusbarFeature(h.pi);
		feature.start(runtime(h.pi, h.ctx));
		const editor = h.editorFactory?.({} as never, {} as never, {} as never);
		expect(editor!.render(100)[0]).toContain("12k/100k");
		h.setUsage({ tokens: 7, percent: 0.007, contextWindow: 100_000 });
		expect(editor!.render(100)[0]).toContain("12k/100k");
		h.setBranch([
			{
				id: "root",
				parentId: null,
				timestamp: new Date().toISOString(),
				type: "message",
				message: { role: "user", content: "x".repeat(400), timestamp: Date.now() },
			},
		]);
		h.setUsage({ tokens: null, percent: null, contextWindow: 100_000 });
		h.emit("session_compact");
		const compacted = editor!.render(100)[0]!;
		expect(compacted).not.toContain("??");
		expect(compacted).not.toContain("12k/100k");
	});

	test("holds the last stable usage while a response is pending", () => {
		const h = harness("a");
		h.setEditor(editorFactory("previous", []));
		const feature = createStatusbarFeature(h.pi);
		feature.start(runtime(h.pi, h.ctx));
		const editor = h.editorFactory?.({} as never, {} as never, {} as never);
		expect(editor!.render(100)[0]).toContain("12k/100k");

		h.setUsage({ tokens: 24_000, percent: 24, contextWindow: 100_000 });
		h.emitValue("message_start", { message: { role: "user" } });
		expect(editor!.render(100)[0]).toContain("12k/100k");
		h.emitValue("turn_start", { turnIndex: 0, timestamp: Date.now() });
		expect(editor!.render(100)[0]).toContain("12k/100k");

		h.setUsage({ tokens: 12_500, percent: 12.5, contextWindow: 100_000 });
		h.emitValue("message_end", { message: { role: "assistant" } });
		expect(editor!.render(100)[0]).toContain("12.5k/100k");

		h.setUsage({ tokens: 25_000, percent: 25, contextWindow: 100_000 });
		h.emitValue("message_start", { message: { role: "user" } });
		expect(editor!.render(100)[0]).toContain("12.5k/100k");
		h.emitValue("message_end", { message: { role: "assistant", stopReason: "error" } });
		expect(editor!.render(100)[0]).toContain("12.5k/100k");
		h.emit("agent_end");
		expect(editor!.render(100)[0]).toContain("12.5k/100k");
		h.emit("agent_settled");
		expect(editor!.render(100)[0]).toContain("25k/100k");
	});

	test("resets stable usage after tree navigation", () => {
		const h = harness("a");
		h.setEditor(editorFactory("previous", []));
		const feature = createStatusbarFeature(h.pi);
		feature.start(runtime(h.pi, h.ctx));
		const editor = h.editorFactory?.({} as never, {} as never, {} as never);
		expect(editor!.render(100)[0]).toContain("12k/100k");
		h.setUsage({ tokens: 500, percent: 0.5, contextWindow: 100_000 });
		h.emit("session_tree");
		expect(editor!.render(100)[0]).toContain("500/100k");
	});

	test("coalesces repeated render requests in one event burst", async () => {
		const h = harness("a");
		const feature = createStatusbarFeature(h.pi);
		feature.start(runtime(h.pi, h.ctx));
		h.makeFooter();

		h.emitValue("message_start", { message: { role: "user" } });
		h.emitValue("turn_start", { turnIndex: 0, timestamp: Date.now() });
		h.emitValue("message_end", { message: { role: "assistant" } });

		expect(h.requests).toBe(1);
		await Promise.resolve();
		expect(h.requests).toBe(1);
	});

	test("redraws fresh contexts for the owned session and ignores other sessions", async () => {
		const h = harness("a");
		const feature = createStatusbarFeature(h.pi);
		feature.start(runtime(h.pi, h.ctx));
		h.makeFooter();
		for (const event of [
			"model_select",
			"thinking_level_select",
			"session_info_changed",
			"session_compact",
			"session_tree",
		])
			h.emit(event);
		h.emitValue("message_end", { message: { role: "assistant" } });
		expect(h.requests).toBe(1);
		await Promise.resolve();
		expect(h.requests).toBe(1);
		h.emit("model_select", { ...h.ctx } as ExtensionContext);
		await Promise.resolve();
		expect(h.requests).toBe(2);
		h.emit("model_select", {
			...h.ctx,
			sessionManager: { getSessionId: () => "stale" },
		} as ExtensionContext);
		await Promise.resolve();
		expect(h.requests).toBe(2);
	});

	test("accepts Pi reset before B and rejects stale A lifecycle actions", async () => {
		const h = harness("a");
		const feature = createStatusbarFeature(h.pi);
		const a = editorFactory("A", []);
		h.setEditor(a);
		feature.start(runtime(h.pi, h.ctx));
		const staleFooter = h.factory;
		h.setId("b");
		h.resetExtensionUi();
		const b = editorFactory("B", []);
		h.setEditor(b);
		feature.start(runtime(h.pi, h.ctx));
		expect(h.restored).toBe(1);
		expect(h.installs).toBe(2);
		h.makeFooter();
		const before = h.requests;
		staleFooter?.(
			{
				requestRender: () => {
					h.emitValue("message_end", { message: { role: "assistant" } });
				},
			} as never,
			{} as never,
			{ getExtensionStatuses: () => h.statusMap } as never,
		);
		h.emitValue("message_start", { message: { role: "user" } });
		await Promise.resolve();
		expect(h.requests).toBe(before + 1);
		feature.dispose("a");
		expect(h.restored).toBe(1);
		feature.dispose("b");
		expect(h.restored).toBe(1);
		h.resetExtensionUi();
		expect(h.restored).toBe(2);
		feature.dispose("b");
		expect(h.restored).toBe(2);
	});

	test("leaves later editor replacement for Pi to reset", () => {
		const h = harness("a");
		const feature = createStatusbarFeature(h.pi);
		feature.start(runtime(h.pi, h.ctx));
		const replacement = editorFactory("replacement", []);
		h.setEditor(replacement);
		feature.dispose("a");
		expect(h.editorFactory).toBe(replacement);
		expect(h.restored).toBe(0);
	});

	test("does not install when editor getter seam is unavailable", () => {
		const h = harness("a", "tui", false);
		const feature = createStatusbarFeature(h.pi);
		feature.start(runtime(h.pi, h.ctx));
		expect(h.installs).toBe(0);
		expect(h.editorSets).toBe(0);
		expect(h.restored).toBe(0);
	});

	test("does not install outside TUI", () => {
		const h = harness("json", "json");
		const feature = createStatusbarFeature(h.pi);
		feature.start(runtime(h.pi, h.ctx));
		expect(h.installs).toBe(0);
		expect(h.restored).toBe(0);
	});
});
