import {
	AssistantMessageComponent,
	type ExtensionContext,
	type ExtensionUIContext,
	InteractiveMode,
	initTheme,
	type Theme,
	ToolExecutionComponent,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Spacer,
	Text,
	type TUI,
	TuiMainScreen,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { installHostToolGroups } from "../src/host-transcript-patch.js";
import { createMessageView } from "../src/message-view.js";
import {
	renderWithoutToolRails,
	type ToolStatusKind,
	ToolView,
	type ToolViewChild,
} from "../src/tool-view.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;
const cleanups: (() => void)[] = [];
const seam = "getRegisteredToolDefinition";
const originalSeam = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, seam);
const noticeSeam = "showExtensionNotify";
const originalNoticeSeam = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, noticeSeam);

beforeAll(() => initTheme("dark", false));
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	expect(Object.getOwnPropertyDescriptor(InteractiveMode.prototype, seam)).toEqual(originalSeam);
	expect(Object.getOwnPropertyDescriptor(InteractiveMode.prototype, noticeSeam)).toEqual(
		originalNoticeSeam,
	);
});

function assistant(
	ids: string[],
	mixed: boolean | "text" = false,
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number },
	thinking = "reason",
): AssistantMessageComponent {
	type Message = Parameters<AssistantMessageComponent["updateContent"]>[0];
	const message: Message = {
		role: "assistant",
		content: [
			...(mixed === "text"
				? [{ type: "text" as const, text: "prose boundary" }]
				: mixed
					? [{ type: "thinking" as const, thinking }]
					: []),
			...ids.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: {} })),
		],
		api: "openai-completions",
		provider: "openai",
		model: "fixture",
		usage: {
			input: usage?.input ?? 0,
			output: usage?.output ?? 0,
			cacheRead: usage?.cacheRead ?? 0,
			cacheWrite: usage?.cacheWrite ?? 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
	return new AssistantMessageComponent(message);
}

function setup(connect = true) {
	let expanded = false;
	let idle = true;
	const notify = vi.fn();
	const requestRender = vi.fn();
	const copyToClipboard = vi.fn(async (_text: string) => {});
	// Obtain the complete native UI facade; override only services exercised here.
	const host: object = Object.create(InteractiveMode.prototype);
	const ui: ExtensionUIContext = Reflect.apply(
		Reflect.get(host, "createExtensionUIContext"),
		host,
		[],
	);
	Object.defineProperty(ui, "theme", { value: theme });
	Object.assign(ui, {
		notify,
		getToolsExpanded: () => expanded,
		setToolsExpanded: (value: boolean) => {
			expanded = value;
		},
	});
	const context = { ui, mode: "tui", isIdle: () => idle } as ExtensionContext;
	const chat = new Container();
	const definitions = new Map<string, ToolRenderers>();
	const resolve = vi.fn((name: string) => definitions.get(name));
	// Use the real host prototype; only session services are fixture-owned.
	Object.defineProperties(host, {
		chatContainer: { value: chat },
		ui: { value: { requestRender } },
		session: {
			value: {
				extensionRunner: {
					getUIContext: () => ui,
					resolveToolRenderers: resolve,
				},
			},
		},
	});
	const lookup = (name: string): unknown => Reflect.apply(Reflect.get(host, seam), host, [name]);
	const originals = {
		render: chat.render,
		handleMouse: chat.handleMouse,
		invalidate: chat.invalidate,
	};
	const patch = installHostToolGroups(context);
	cleanups.push(patch.dispose);
	if (connect) lookup("fixture");
	const notice = (message: string, type: "info" | "warning" | "error" = "info") =>
		Reflect.apply(Reflect.get(host, noticeSeam), host, [message, type]);
	const row = (
		id: string,
		name = "read",
		status: ToolStatusKind = "ok",
		callError = false,
		complete = true,
		children?: ToolViewChild[],
		childCount?: number,
	) => {
		let callView: ToolView | undefined;
		// Real TUI prototype, with the only service used by ToolExecutionComponent replaced.
		const tui: TUI = Object.assign(Object.create(TuiMainScreen.prototype), { requestRender });
		const tool = new ToolExecutionComponent(
			name,
			id,
			{},
			{ showImages: false },
			{
				renderShell: "self",
				renderCall: (args, _theme, ctx) => {
					if (callError) throw new Error("call renderer failed");
					callView = new ToolView({
						theme,
						header: {
							title: name,
							status: ctx.argsComplete ? "running" : "streaming",
							summary: JSON.stringify(args),
						},
					});
					if (complete) callView.hide();
					return callView;
				},
				renderResult: (_result, options, _theme, ctx) => {
					callView?.hide();
					return new ToolView({
						theme,
						header: {
							title: name,
							status: ctx.isError ? "error" : options.isPartial ? "running" : status,
						},
						...(children === undefined ? {} : { children }),
						...(childCount === undefined ? {} : { childCount }),
						sections: [{ railToken: "dim", content: `RESULT ${id}` }],
						copy: { primary: `COPY ${id}` },
						copyToClipboard,
						defaultLevel: 1,
					});
				},
			},
			tui,
			process.cwd(),
		);
		if (complete) {
			tool.setArgsComplete();
			tool.markExecutionStarted();
			tool.updateResult({ content: [{ type: "text", text: `RESULT ${id}` }], isError: false });
		}
		return tool;
	};
	return {
		chat,
		patch,
		context,
		host,
		originals,
		notify,
		requestRender,
		resolve,
		lookup,
		notice,
		row,
		begin: () => patch.beginRun(),
		copyToClipboard,
		setIdle: (value: boolean) => {
			idle = value;
		},
		setExpanded: (value: boolean) => {
			expanded = value;
		},
	};
}

function click(chat: Container, y: number, width = 80, x = 0) {
	const height = chat.render(width).length;
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x,
		y,
		screenX: 0,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
	};
	return chat.handleMouse(event);
}

function show(chat: Container, width = 80): string {
	return chat.render(width).join("\n");
}

function clickRow(chat: Container, needle: string) {
	const index = chat.render(80).findIndex((row) => row.includes(needle));
	if (index < 0) throw new Error(`No transcript row matching ${needle}`);
	return click(chat, index);
}

describe("two centralized host seams / original transcript projection", () => {
	test("counts real adjacent tools; preserves children and original methods on disposal", () => {
		const f = setup();
		f.begin();
		const rows = [assistant(["a", "b", "c"]), f.row("a"), f.row("b"), f.row("c", "grep")];
		f.chat.children = rows;
		expect(show(f.chat)).toContain("▸ read ×2");
		expect(show(f.chat)).toContain("3 calls");
		expect(show(f.chat)).toContain("✓ grep");
		expect(show(f.chat)).not.toContain("RESULT");
		expect(f.chat.children).toBe(rows);
		f.patch.dispose();
		f.patch.dispose();
		expect(f.chat.render).toBe(f.originals.render);
		expect(f.chat.handleMouse).toBe(f.originals.handleMouse);
		expect(f.chat.invalidate).toBe(f.originals.invalidate);
		expect(show(f.chat)).toContain("RESULT a");
	});

	test("mouse and global expansion retain local choices and original child hit testing", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		expect(click(f.chat, 1)).toMatchObject({ handled: true });
		expect(show(f.chat)).toContain("RESULT a");
		f.setExpanded(true);
		click(f.chat, 1);
		expect(show(f.chat)).toContain("RESULT a");
		f.setExpanded(false);
		expect(show(f.chat)).not.toContain("RESULT a");
		f.setExpanded(true);
		expect(show(f.chat)).toContain("RESULT b");
		f.setExpanded(false);
		expect(show(f.chat)).not.toContain("RESULT b");
	});

	test("unknown nodes, including empty nodes, break groups", () => {
		const f = setup();
		f.begin();
		f.chat.children = [
			assistant(["a", "b", "c", "d"]),
			f.row("a"),
			f.row("b"),
			new Text("NOTICE", 0, 0),
			f.row("c"),
			f.row("d"),
		];
		expect(show(f.chat).match(/collapse views/g)).toHaveLength(2);
		expect(show(f.chat).match(/Requests ×1/g)).toHaveLength(1);
		expect(show(f.chat)).toContain("NOTICE");
		f.chat.children.splice(3, 1, { render: () => [], invalidate() {} });
		expect(show(f.chat).match(/collapse views/g)).toHaveLength(2);
		expect(show(f.chat)).not.toContain("4 calls");
	});

	test("the tools row lists effective calls and the header toggles the raw view", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		expect(click(f.chat, 3, 80, 4)).toMatchObject({ handled: true });
		expect(show(f.chat)).toContain("▾ read ×1");
		expect(show(f.chat)).toContain("✓ read");
		expect(click(f.chat, 3, 80, 4)).toMatchObject({ handled: true });
		expect(show(f.chat)).toContain("▸ read ×1");
		expect(click(f.chat, 1, 80, 4)).toMatchObject({ handled: true });
		expect(show(f.chat)).toContain("RESULT a");
		expect(show(f.chat)).toContain("▾ collapse views");
		expect(click(f.chat, 1, 80, 4)).toMatchObject({ handled: true });
		expect(show(f.chat)).not.toContain("RESULT");
		expect(show(f.chat)).toContain("▸ collapse views");
	});

	test("expanded member clicks use original tool geometry", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		click(f.chat, 1);
		const header = f.chat.render(80).findIndex((line, index) => index > 1 && line.includes("read"));
		expect(header).toBeGreaterThan(1);
		expect(click(f.chat, header, 80, 2)).toMatchObject({ handled: true });
		expect(show(f.chat)).not.toContain("RESULT a");
		expect(show(f.chat)).toContain("RESULT b");
	});

	test("expanded tools are consecutive while body blank lines remain intact", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		click(f.chat, 1);
		expect(show(f.chat)).toContain("RESULT a");
		expect(show(f.chat)).toContain("▾ ✓ read");
		const tool = f.chat.children[1];
		expect(tool).toBeInstanceOf(ToolExecutionComponent);
		if (!(tool instanceof ToolExecutionComponent)) throw new Error("Missing fixture tool");
		tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		const view = Reflect.get(tool, "resultRendererComponent");
		expect(view).toBeInstanceOf(ToolView);
		if (!(view instanceof ToolView)) throw new Error("Missing fixture result view");
		const render = view.render.bind(view);
		view.render = (width) => [...render(width), "", "body after blank"];
		expect(show(f.chat)).toContain("RESULT a\n\nbody after blank");
	});

	test("expanded copy actions keep original right-edge geometry and one outer rail", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		click(f.chat, 1);
		const header = f.chat.render(80).findIndex((line, index) => index > 1 && line.includes("read"));
		expect(click(f.chat, header, 80, 78)).toMatchObject({ handled: true });
		expect(f.copyToClipboard).toHaveBeenCalledWith("COPY a");
		expect(show(f.chat)).toContain("RESULT a");
		expect(show(f.chat)).not.toContain("▎ ▎");
		for (const width of [8, 24, 80]) {
			for (const line of f.chat.render(width))
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("call renderer fallback remains visible even when result presentation succeeds", () => {
		const f = setup();
		f.chat.children = [assistant(["a", "b"]), f.row("a", "read", "ok", true), f.row("b")];
		expect(show(f.chat)).not.toContain("2 calls");
		expect(show(f.chat)).toContain("RESULT a");
	});

	test("original host errors propagate through the seam", () => {
		const f = setup();
		f.resolve.mockImplementation(() => {
			throw new Error("host failure");
		});
		expect(() => f.lookup("fixture")).toThrow("host failure");
		expect(f.notify).not.toHaveBeenCalled();
	});

	test("a non-writable instance rejects grouping without partially patching it", () => {
		const f = setup();
		f.patch.dispose();
		Object.defineProperty(f.chat, "handleMouse", {
			value: f.originals.handleMouse,
			configurable: true,
			writable: false,
		});
		const patch = installHostToolGroups(f.context);
		cleanups.push(patch.dispose);
		f.lookup("fixture");
		expect(f.chat.render).toBe(f.originals.render);
		expect(f.chat.invalidate).toBe(f.originals.invalidate);
		expect(f.notify).toHaveBeenCalledTimes(1);
	});

	test("thinking rounds merge; prose remains a boundary", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"], true), f.row("a"), f.row("b")];
		expect(show(f.chat)).toContain("2 calls");
		expect(show(f.chat)).toContain("thinking · 2 tokens");
		expect(show(f.chat)).not.toContain("reason");
		f.chat.children = [assistant(["a"]), f.row("a"), assistant(["b"], true), f.row("b")];
		expect(show(f.chat)).toContain("2 calls");
		f.chat.children.splice(2, 0, assistant([], "text"));
		expect(show(f.chat)).not.toContain("2 calls");
		expect(show(f.chat)).toContain("prose boundary");
	});

	test.each([
		"warn",
		"error",
		"none",
		"running",
	] as const)("%s presentation keeps its summary in the group", (status) => {
		const f = setup();
		f.begin();
		f.chat.children = [
			assistant(["a", "b", "c"]),
			f.row("a"),
			f.row("b", "read", status),
			f.row("c"),
		];
		expect(show(f.chat)).toContain("3 calls");
		expect(show(f.chat)).not.toContain("RESULT b");
	});

	test("partial and failed results update summaries; images and unknown renderers break groups", () => {
		const f = setup();
		f.begin();
		for (const kind of ["partial", "error", "image", "fallback"] as const) {
			const middle = f.row("b");
			if (kind === "partial")
				middle.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
			if (kind === "error")
				middle.updateResult({ content: [{ type: "text", text: "error" }], isError: true });
			if (kind === "image")
				middle.updateResult({
					content: [{ type: "image", data: "", mimeType: "image/png" }],
					isError: false,
				});
			if (kind === "fallback") Reflect.set(middle, "resultRendererComponent", new Text("native"));
			f.chat.children = [assistant(["a", "b", "c"]), f.row("a"), middle, f.row("c")];
			if (kind === "partial" || kind === "error") expect(show(f.chat)).toContain("3 calls");
			else expect(show(f.chat)).not.toContain("×");
		}
	});

	test("groups form during streaming and keep the tail read-only", () => {
		const f = setup();
		f.begin();
		f.setIdle(false);
		const live = f.row("b", "read", "ok", false, false);
		f.chat.children = [assistant(["a", "b"]), f.row("a"), live];
		expect(show(f.chat)).toContain("2 calls");
		expect(show(f.chat)).toContain("▸ read ×1");
		expect(show(f.chat)).toContain("⋯ read");
		live.updateArgs({ path: "new-path" });
		expect(show(f.chat)).not.toContain("new-path");
		live.setArgsComplete();
		live.markExecutionStarted();
		expect(show(f.chat)).toContain("◐ read");
		live.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
		expect(show(f.chat)).toContain("◐ read");
		live.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		expect(show(f.chat)).toContain("✓ read");
		expect(show(f.chat)).not.toContain("◐ read");
		click(f.chat, 1);
		f.chat.children.push(assistant(["c"], true), f.row("c"));
		expect(show(f.chat)).toContain("3 calls");
		expect(show(f.chat)).toContain("RESULT c");
		click(f.chat, 1);
		expect(show(f.chat)).not.toContain("RESULT c");
		expect(show(f.chat)).toContain("3 calls");
		expect(show(f.chat)).toContain("▸ read ×2");
	});

	test("one run origin spans native boundaries and freezes when the loop ends", () => {
		const f = setup();
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		f.patch.beginRun();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		now.mockReturnValue(1000);
		expect(show(f.chat)).toContain("1s");
		f.chat.children.push(new Text("NOTICE", 0, 0), assistant(["c", "d"]), f.row("c"), f.row("d"));
		now.mockReturnValue(65_000);
		click(f.chat, 1);
		expect(show(f.chat).match(/1m 05s/g)).toHaveLength(2);
		f.patch.endRun();
		now.mockReturnValue(600_000);
		expect(show(f.chat)).toContain("1m 05s");
		expect(show(f.chat)).toContain("Requests ×1");
		f.patch.beginRun();
		f.chat.children.push(new Text("NOTICE", 0, 0), assistant(["e", "f"]), f.row("e"), f.row("f"));
		now.mockReturnValue(605_000);
		expect(show(f.chat)).toContain("5s");
	});

	test("a finished block keeps its frame and gains a request footer", () => {
		const f = setup();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		const rows = show(f.chat).trim().split("\n");
		expect(rows[0]).toContain("▸ collapse views · — · 2 calls");
		expect(rows).toContain("▸ read ×2");
		expect(rows.filter((row) => row.startsWith("─"))).toHaveLength(2);
		expect(rows).not.toContain("✓ read");
		expect(rows.at(-1)).toBe("Requests ×1 · IN 0 · OUT 0 · CH —");
	});

	test("a block settles when the transcript moves past it, not only when the run ends", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b", "grep")];
		expect(show(f.chat)).toContain("✓ grep");
		expect(show(f.chat)).not.toContain("Requests ×1");

		f.chat.children.push(new Text("prose after the block", 0, 0));
		expect(show(f.chat)).toContain("Requests ×1");
		expect(show(f.chat)).not.toContain("✓ grep");
	});

	test("the footer names the call still running, not a later one that finished", () => {
		const f = setup();
		f.begin();
		const stillRunning = f.row("a", "grep", "running");
		// A tool that started and has not produced its final result: the host marks it partial.
		Reflect.set(stillRunning, "isPartial", true);
		f.chat.children = [assistant(["a", "b"]), stillRunning, f.row("b", "read", "ok")];
		const rows = show(f.chat).split("\n");
		expect(rows.at(-1)).toContain("grep");
		expect(show(f.chat)).toContain("▸ read ×1");
	});

	test("closing the host's forced expansion returns to the collapsed aggregate", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		const header = () => show(f.chat).trim().split("\n")[0] ?? "";

		click(f.chat, 1);
		expect(header()).toContain("▾ collapse views");
		f.setExpanded(true);
		expect(header()).toContain("▾ collapse views");
		f.setExpanded(false);
		expect(header()).toContain("▸ collapse views");
		expect(show(f.chat)).toContain("▸ read ×1");
	});

	test("a collapsed frame is two rails, one summary, and the tail at every width", () => {
		const f = setup();
		f.begin();
		const failed = f.row("b", "read");
		failed.updateResult({ content: [{ type: "text", text: "boom" }], isError: true });
		f.chat.children = [assistant(["a", "b"]), f.row("a", "grep"), failed];
		const rows = f.chat.render(24);
		expect(rows.filter((row) => row.startsWith("─"))).toHaveLength(2);
		expect(rows).toContain("✗ read");
		expect(rows).toContain("▸ grep ×1");
		for (const width of [8, 24, 80]) {
			for (const line of f.chat.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(line).not.toMatch(/[\r\n]/);
			}
		}
	});

	test("a container's children replace it in the call count and the flat list", () => {
		const f = setup();
		f.begin();
		const children: ToolViewChild[] = [
			{ title: "read", summary: "a.ts", status: "ok" },
			{ title: "grep", summary: "needle", status: "error", detail: "no match\nsecond line" },
		];
		f.chat.children = [
			assistant(["a", "b", "c"]),
			f.row("a", "grep"),
			f.row("b", "codemode", "none", false, true, children),
			f.row("c", "read"),
		];
		expect(show(f.chat)).toContain("4 calls");
		expect(show(f.chat)).toContain("▸ grep ×2 · read ×1");
		clickRow(f.chat, "▸ grep ×2");
		expect(show(f.chat)).toContain("▸ ✓ read a.ts");
		expect(show(f.chat)).toContain("▸ ✗ grep needle");
		expect(show(f.chat).split("\n")).toContain("");
		clickRow(f.chat, "✗ grep needle");
		expect(show(f.chat)).toContain("no match");
		expect(show(f.chat)).toContain("second line");
		expect(show(f.chat)).not.toContain("RESULT b");
	});

	test("an expanded tool keeps its own row geometry inside the tools category", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		clickRow(f.chat, "▸ read ×1");
		expect(show(f.chat)).toContain("RESULT a");
		clickRow(f.chat, "RESULT a");
		expect(show(f.chat)).toContain("RESULT a");
		clickRow(f.chat, "✓ read");
		expect(show(f.chat)).not.toContain("RESULT a");
	});

	test("one category and one item open at a time", () => {
		const f = setup();
		f.begin();
		const notice = new Container();
		notice.addChild(
			createMessageView({
				theme,
				header: { kind: "memory", summary: "page", tone: "success" },
				body: "remembered body",
			}),
		);
		f.chat.children = [assistant(["a", "b"], true), f.row("a"), notice, f.row("b")];
		clickRow(f.chat, "▸ thinking");
		expect(show(f.chat)).toContain("▾ thinking · 2 tokens");
		expect(show(f.chat)).toContain("▎ reason");
		clickRow(f.chat, "▸ thinking · 2 tokens");
		expect(show(f.chat)).toContain("reason");
		clickRow(f.chat, "▸ read ×1");
		expect(show(f.chat)).toContain("▾ read ×1");
		expect(show(f.chat)).toContain("▸ thinking");
		expect(show(f.chat)).not.toContain("reason");
		clickRow(f.chat, "▸ notice · memory ×1");
		expect(show(f.chat)).toContain("▾ notice · memory ×1");
		clickRow(f.chat, "▸ memory · page");
		expect(show(f.chat)).toContain("remembered body");
	});

	test("categories render notice, then thinking, then tools", () => {
		const f = setup();
		f.begin();
		const notice = new Container();
		notice.addChild(
			createMessageView({
				theme,
				header: { kind: "memory", summary: "page", tone: "success" },
				body: "remembered body",
			}),
		);
		f.chat.children = [assistant(["a", "b"], true), f.row("a"), notice, f.row("b")];
		const rows = show(f.chat).split("\n");
		const order = ["▸ notice · memory ×1", "▸ thinking · 2 tokens", "▸ read ×1"].map((row) =>
			rows.findIndex((line) => line.startsWith(row)),
		);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		for (const index of order) expect(index).toBeGreaterThanOrEqual(0);
	});

	test("thinking text stays hidden when the host hides it", () => {
		const f = setup();
		f.begin();
		const message = assistant(["a", "b"], true);
		Reflect.set(message, "hideThinkingBlock", true);
		f.chat.children = [message, f.row("a"), f.row("b")];
		clickRow(f.chat, "▸ thinking");
		expect(show(f.chat)).toContain("▸ thinking · 2 tokens");
		clickRow(f.chat, "▸ thinking · 2 tokens");
		expect(show(f.chat)).not.toContain("reason");
	});

	test("a notice with nothing to open gets no pin, a preview-only one does", () => {
		const f = setup();
		f.begin();
		const bare = new Container();
		bare.addChild(createMessageView({ theme, header: { kind: "memory", summary: "page" } }));
		const previewOnly = new Container();
		previewOnly.addChild(
			createMessageView({
				theme,
				header: { kind: "memory", summary: "two" },
				preview: "preview line",
			}),
		);
		f.chat.children = [assistant(["a", "b"]), f.row("a"), bare, previewOnly, f.row("b")];
		clickRow(f.chat, "▸ notice · memory ×2");

		const rows = show(f.chat).split("\n");
		expect(rows.find((row) => row.includes("memory · page"))).not.toContain("▸");
		expect(rows.find((row) => row.includes("memory · two"))).toContain("▸");

		const before = show(f.chat);
		clickRow(f.chat, "memory · page");
		expect(show(f.chat)).toBe(before);
		clickRow(f.chat, "memory · two");
		expect(show(f.chat)).toContain("preview line");
	});

	test("counts a container's calls from its own count, not from the children it lists", () => {
		const f = setup();
		f.begin();
		f.chat.children = [
			assistant(["a", "b"]),
			f.row("a", "read", "ok", false, true, [{ title: "read", summary: "a.txt" }], 3),
			f.row("b"),
		];
		// Two top-level tools, but the container reports three calls: 3 + 1, not 1 + 1.
		expect(show(f.chat)).toContain("4 calls");
	});

	test("a child row in the group shows the duration its container row shows", () => {
		const f = setup();
		f.begin();
		f.chat.children = [
			assistant(["a", "b"]),
			f.row("a", "read", "ok", false, true, [
				{ title: "grep", summary: "TODO", status: "ok", durationMs: 12 },
			]),
			f.row("b"),
		];
		clickRow(f.chat, "▸ grep ×1");
		expect(show(f.chat)).toContain("grep TODO · 12ms");
	});

	test("a finished block reports the native request usage it owns", () => {
		const f = setup();
		f.chat.children = [
			assistant(["a", "b"], false, { input: 999, output: 100, cacheRead: 0, cacheWrite: 0 }),
			f.row("a"),
			f.row("b"),
			assistant(["c", "d"], false, { input: 1000, output: 2000, cacheRead: 9000, cacheWrite: 0 }),
			f.row("c"),
			f.row("d"),
		];
		expect(show(f.chat)).toContain("Requests ×2 · IN 2.0k · OUT 2.1k · CH 90%");
	});

	test.each([
		[999, "999"],
		[1000, "1.0k"],
		[9999, "10.0k"],
		[10_000, "10k"],
		[999_999, "1000k"],
		[1_000_000, "1.0M"],
		[9_999_999, "10.0M"],
		[10_000_000, "10M"],
	])("token counts follow the native footer at %i", (input, expected) => {
		const f = setup();
		f.chat.children = [
			assistant(["a", "b"], false, { input, output: 0, cacheRead: 0, cacheWrite: 0 }),
			f.row("a"),
			f.row("b"),
		];
		expect(show(f.chat)).toContain(`IN ${expected} ·`);
	});

	test("global expansion shows the raw members and closing it restores the closed frame", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		click(f.chat, 3);
		expect(show(f.chat)).toContain("▾ read ×1");
		f.setExpanded(true);
		expect(show(f.chat)).toContain("RESULT a");
		expect(show(f.chat)).toContain("▾ collapse views");
		f.setExpanded(false);
		expect(show(f.chat)).not.toContain("RESULT");
		expect(show(f.chat)).toContain("▸ read ×1");
	});

	test("notifications captured before the first tool keep full text and never count", () => {
		const f = setup(false);
		f.begin();
		f.notice("first notice");
		f.notice("second notice\ndetail", "warning");
		f.chat.children.push(assistant(["a", "b"]), f.row("a"), f.row("b"));
		expect(show(f.chat)).toContain("2 calls");
		expect(show(f.chat)).toContain("▸ notice · info ×1 · warning ×1");
		expect(show(f.chat)).not.toContain("first notice");
		clickRow(f.chat, "▸ notice · info ×1");
		expect(show(f.chat)).toContain("first notice");
		expect(show(f.chat)).toContain("Warning: second notice detail");
		clickRow(f.chat, "▸ Warning: second notice");
		expect(show(f.chat)).toContain(" detail");
		f.patch.dispose();
		f.notice("native after disposal");
		expect(show(f.chat)).toContain("native after disposal");
	});

	test("notices and tool groups survive stale extension context after session replacement or reload", () => {
		const f = setup(false);
		f.begin();
		f.notice("session notice");
		f.chat.children.push(assistant(["a", "b"]), f.row("a"), f.row("b"));
		Object.defineProperty(f.context, "ui", {
			get() {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			},
		});
		expect(() => show(f.chat)).not.toThrow();
		clickRow(f.chat, "▸ notice · info ×1");
		expect(show(f.chat)).toContain("session notice");
		expect(show(f.chat)).toContain("2 calls");
		expect(() => click(f.chat, 1)).not.toThrow();
		expect(show(f.chat)).toContain("read");
	});

	test("MessageView notices stay inside the activity group and raw entries break it", () => {
		const f = setup();
		f.begin();
		const report = new Container();
		Reflect.set(report, "entry", { customType: "bg-bash-info", data: { message: "tail output" } });
		report.addChild(new Spacer(1));
		report.addChild(
			createMessageView({
				theme,
				header: {
					kind: "bg-bash",
					summary: "✓ job · terminal · completed",
					tone: "success",
				},
				body: "tail output",
			}),
		);
		f.chat.children = [assistant(["a", "b"]), f.row("a"), report, f.row("b")];
		const collapsed = show(f.chat);
		expect(collapsed).toContain("2 calls");
		expect(collapsed).toContain("▸ notice · bg-bash ×1");
		expect(collapsed).not.toContain("tail output");
		clickRow(f.chat, "▸ notice · bg-bash ×1");
		expect(show(f.chat)).toContain("bg-bash · ✓ job · terminal · completed");
		clickRow(f.chat, "▸ bg-bash · ✓ job");
		expect(show(f.chat)).toContain("tail output");
		click(f.chat, 1);
		const expanded = show(f.chat);
		expect(expanded).toContain("2 calls");
		expect(expanded).toContain("▸ bg-bash · ✓ job · terminal · completed");
		const agents = new Container();
		agents.addChild(
			createMessageView({
				theme,
				header: { kind: "agents", summary: "✓ child scout · done", tone: "success" },
			}),
		);
		const raw = new Container();
		Reflect.set(raw, "entry", { customType: "foreign-entry" });
		raw.addChild(new Text("foreign"));
		f.chat.children = [assistant(["a", "b"]), f.row("a"), agents, f.row("b")];
		expect(show(f.chat)).toContain("2 calls");
		expect(show(f.chat)).toContain("▸ notice · agents ×1");
		clickRow(f.chat, "▸ notice · agents ×1");
		expect(show(f.chat)).toContain("agents · ✓ child scout · done");
		f.chat.children = [assistant(["a", "b"]), f.row("a"), raw, f.row("b")];
		expect(show(f.chat)).not.toContain("×");
		expect(show(f.chat)).toContain("foreign");
	});

	test("history replacement and theme invalidation use current nodes, not model projection", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		click(f.chat, 1);
		expect(show(f.chat)).toContain("RESULT a");
		f.chat.clear();
		f.chat.children = [assistant(["c", "d"]), f.row("c", "grep"), f.row("d", "grep")];
		f.chat.invalidate();
		expect(show(f.chat)).toContain("▸ grep ×1");
		expect(show(f.chat)).toContain("2 calls");
		expect(show(f.chat)).not.toContain("RESULT");
	});

	test("narrow names remain width-safe and counts retain namespace identity", () => {
		const f = setup();
		f.begin();
		f.chat.children = [
			assistant(["a", "b"]),
			f.row("a", "mcp__one__工具"),
			f.row("b", "mcp__two__工具"),
		];
		for (const width of [8, 24, 80]) {
			for (const line of f.chat.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(line).not.toMatch(/[\r\n]/);
			}
		}
		expect(show(f.chat)).toContain("mcp__one__工具 ×1");
		expect(show(f.chat)).toContain("✓ mcp__two__工具");
	});

	test("two owners share one hook and dispose independently; reinstall works", () => {
		const a = setup();
		const b = setup();
		a.begin();
		b.begin();
		const wrapper = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, seam)?.value;
		a.chat.children = [assistant(["a", "b"]), a.row("a"), a.row("b")];
		b.chat.children = [assistant(["c", "d"]), b.row("c"), b.row("d")];
		expect(show(a.chat)).toContain("2 calls");
		expect(show(b.chat)).toContain("2 calls");
		a.patch.dispose();
		expect(Object.getOwnPropertyDescriptor(InteractiveMode.prototype, seam)?.value).toBe(wrapper);
		expect(show(a.chat)).not.toContain("2 calls");
		expect(show(b.chat)).toContain("2 calls");
		b.patch.dispose();
		const again = installHostToolGroups(a.context);
		cleanups.push(again.dispose);
		again.beginRun();
		expect(show(a.chat)).toContain("2 calls");
	});

	test("reload reattaches rebuilt history with the current module generation", async () => {
		const f = setup();
		f.patch.dispose();
		vi.resetModules();
		const { ToolView: ReloadedView } = await import("../src/tool-view.js");
		const { installHostToolGroups: reinstall } = await import("../src/host-transcript-patch.js");
		const rows = [f.row("a"), f.row("b")];
		for (const row of rows) {
			const call = new ReloadedView({ theme, header: { title: "read", status: "running" } });
			call.hide();
			Reflect.set(row, "callRendererComponent", call);
			Reflect.set(
				row,
				"resultRendererComponent",
				new ReloadedView({
					theme,
					header: { title: "read", status: "ok" },
				}),
			);
		}
		f.chat.children = [assistant(["a", "b"]), ...rows];
		const patch = reinstall(f.context);
		cleanups.push(patch.dispose);
		patch.beginRun();
		// No additional tool lookup: history was already rebuilt before session_start.
		expect(show(f.chat)).toContain("2 calls");
	});

	test("instance shape mismatch falls back to original transcript and reports once", () => {
		const f = setup();
		const row = f.row("a");
		Reflect.deleteProperty(row, "toolCallId");
		f.chat.children = [assistant(["a", "b"]), row, f.row("b")];
		expect(show(f.chat)).toContain("RESULT b");
		show(f.chat);
		expect(f.notify).toHaveBeenCalledTimes(1);
	});

	test("does not overwrite an intervening instance patch; old wrapper becomes pass-through", () => {
		const f = setup();
		const wrapper = f.chat.render;
		const other = (width: number) => wrapper.call(f.chat, width);
		f.chat.render = other;
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		f.patch.dispose();
		expect(f.chat.render).toBe(other);
		expect(show(f.chat)).toContain("RESULT a");
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("restart Pi"), "warning");
	});

	test("container summaries do not require rendering their bodies", () => {
		const render = vi.fn(() => ["private body"]);
		const view = new ToolView({
			theme,
			header: { title: "codemode", status: "none", summary: "2 calls" },
			collapsedRows: { render, invalidate() {} },
		});
		expect(view.summary).toBe("codemode 2 calls");
		expect(render).not.toHaveBeenCalled();
		view.hide();
		expect(view.summary).toBeUndefined();
	});

	test("outer-rail embedding restores cache mode and child mouse coordinates", () => {
		const handleMouse = vi.fn((_event: TuiMouseEvent) => ({ handled: true }));
		const view = new ToolView({
			theme,
			header: { title: "codemode", status: "none" },
			collapsedRows: { render: () => ["child"], invalidate() {}, handleMouse },
		});
		expect(view.render(40)[1]).toBe("▎ child");
		expect(renderWithoutToolRails(view, 40)[1]).toBe("child");
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 6,
			y: 1,
			screenX: 6,
			screenY: 1,
			width: 40,
			height: 2,
			shift: false,
			alt: false,
			ctrl: false,
		};
		view.handleMouse(event);
		expect(handleMouse).toHaveBeenLastCalledWith(
			expect.objectContaining({ x: 6, y: 0, width: 40 }),
		);
		expect(view.render(40)[1]).toBe("▎ child");
		view.handleMouse(event);
		expect(handleMouse).toHaveBeenLastCalledWith(
			expect.objectContaining({ x: 4, y: 0, width: 38 }),
		);
		expect(() =>
			renderWithoutToolRails(
				{
					render() {
						throw new Error("render failed");
					},
					invalidate() {},
				},
				40,
			),
		).toThrow("render failed");
		view.invalidate();
		expect(view.render(40)[1]).toBe("▎ child");
	});

	/** A line far wider than the frame, with a marker only the last wrapped row can carry. */
	const longLine = `HEAD ${"x".repeat(80)} TAIL-MARKER`;

	test("expanded thinking wraps a long line instead of cutting its tail", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"], true, undefined, longLine), f.row("a"), f.row("b")];
		const width = 20;
		const rows = () => f.chat.render(width);
		const category = rows().findIndex((row) => row.includes("thinking"));
		expect(category).toBeGreaterThan(-1);
		click(f.chat, category, width);
		const item = rows().findIndex((row, index) => index > category && row.includes("thinking"));
		expect(item).toBeGreaterThan(category);
		click(f.chat, item, width);

		const opened = rows();
		expect(opened.join("\n")).toContain("TAIL-MARKER");
		for (const row of opened) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
	});

	test("expanded child detail wraps a long line instead of cutting its tail", () => {
		const f = setup();
		f.begin();
		f.chat.children = [
			assistant(["a", "b"]),
			f.row("a", "read", "ok", false, true, [{ title: "grep", status: "ok", detail: longLine }]),
			f.row("b"),
		];
		const width = 20;
		const rows = () => f.chat.render(width);
		const category = rows().findIndex((row) => row.includes("grep ×1"));
		expect(category).toBeGreaterThan(-1);
		click(f.chat, category, width);
		const item = rows().findIndex((row, index) => index > category && row.includes("grep"));
		expect(item).toBeGreaterThan(category);
		click(f.chat, item, width);

		const opened = rows();
		expect(opened.join("\n")).toContain("TAIL-MARKER");
		for (const row of opened) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
	});
});
