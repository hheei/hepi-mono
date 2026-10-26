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
	Text,
	type TUI,
	TuiMainScreen,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { installHostToolGroups } from "../src/host-transcript-patch.js";
import { renderWithoutToolRails, type ToolStatusKind, ToolView } from "../src/tool-view.js";

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
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	expect(Object.getOwnPropertyDescriptor(InteractiveMode.prototype, seam)).toEqual(originalSeam);
	expect(Object.getOwnPropertyDescriptor(InteractiveMode.prototype, noticeSeam)).toEqual(
		originalNoticeSeam,
	);
});

function assistant(ids: string[], mixed: boolean | "text" = false): AssistantMessageComponent {
	type Message = Parameters<AssistantMessageComponent["updateContent"]>[0];
	const message: Message = {
		role: "assistant",
		content: [
			...(mixed === "text"
				? [{ type: "text" as const, text: "prose boundary" }]
				: mixed
					? [{ type: "thinking" as const, thinking: "reason" }]
					: []),
			...ids.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: {} })),
		],
		api: "openai-completions",
		provider: "openai",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
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
		if (complete)
			tool.updateResult({ content: [{ type: "text", text: `RESULT ${id}` }], isError: false });
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

describe("two centralized host seams / original transcript projection", () => {
	test("counts real adjacent tools; preserves children and original methods on disposal", () => {
		const f = setup();
		const rows = [assistant(["a", "b", "c"]), f.row("a"), f.row("b"), f.row("c", "grep")];
		f.chat.children = rows;
		expect(show(f.chat)).toContain("▸ read ×2 · grep ×1");
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
		f.chat.children = [
			assistant(["a", "b", "c", "d"]),
			f.row("a"),
			f.row("b"),
			new Text("NOTICE", 0, 0),
			f.row("c"),
			f.row("d"),
		];
		expect(show(f.chat).match(/read ×2/g)).toHaveLength(2);
		expect(show(f.chat)).toContain("NOTICE");
		f.chat.children.splice(3, 1, { render: () => [], invalidate() {} });
		expect(show(f.chat).match(/read ×2/g)).toHaveLength(2);
		expect(show(f.chat)).not.toContain("read ×4");
	});

	test("expanded member clicks use original tool geometry", () => {
		const f = setup();
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
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		click(f.chat, 1);
		expect(show(f.chat)).toContain("▎ RESULT a\n▎ ▾ ✓ read");
		const tool = f.chat.children[1];
		expect(tool).toBeInstanceOf(ToolExecutionComponent);
		if (!(tool instanceof ToolExecutionComponent)) throw new Error("Missing fixture tool");
		tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		const view = Reflect.get(tool, "resultRendererComponent");
		expect(view).toBeInstanceOf(ToolView);
		if (!(view instanceof ToolView)) throw new Error("Missing fixture result view");
		const render = view.render.bind(view);
		view.render = (width) => [...render(width), "", "body after blank"];
		expect(show(f.chat)).toContain("▎ RESULT a\n▎ \n▎ body after blank\n▎ ▾ ✓ read");
	});

	test("expanded copy actions keep original right-edge geometry and one outer rail", () => {
		const f = setup();
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
		expect(show(f.chat)).not.toContain("×2");
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
		f.chat.children = [assistant(["a", "b"], true), f.row("a"), f.row("b")];
		expect(show(f.chat)).toContain("read ×2");
		expect(show(f.chat)).toContain("thinking…");
		expect(show(f.chat)).not.toContain("reason");
		f.chat.children = [assistant(["a"]), f.row("a"), assistant(["b"], true), f.row("b")];
		expect(show(f.chat)).toContain("read ×2");
		f.chat.children.splice(2, 0, assistant([], "text"));
		expect(show(f.chat)).not.toContain("read ×2");
		expect(show(f.chat)).toContain("prose boundary");
	});

	test.each([
		"warn",
		"error",
		"none",
		"running",
	] as const)("%s presentation keeps its summary in the group", (status) => {
		const f = setup();
		f.chat.children = [
			assistant(["a", "b", "c"]),
			f.row("a"),
			f.row("b", "read", status),
			f.row("c"),
		];
		expect(show(f.chat)).toContain("read ×3");
		expect(show(f.chat)).not.toContain("RESULT b");
	});

	test("partial and failed results update summaries; images and unknown renderers break groups", () => {
		const f = setup();
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
			if (kind === "partial" || kind === "error") expect(show(f.chat)).toContain("read ×3");
			else expect(show(f.chat)).not.toContain("×");
		}
	});

	test("groups form during streaming and append members without losing expansion", () => {
		const f = setup();
		f.setIdle(false);
		const live = f.row("b", "read", "ok", false, false);
		f.chat.children = [assistant(["a", "b"]), f.row("a"), live];
		expect(show(f.chat)).toContain("read ×2");
		expect(show(f.chat)).toContain("⋯ read");
		live.updateArgs({ path: "new-path" });
		expect(show(f.chat)).toContain("new-path");
		live.setArgsComplete();
		live.markExecutionStarted();
		expect(show(f.chat)).toContain("◐ read");
		live.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
		expect(show(f.chat)).toContain("◐ read");
		live.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		expect(show(f.chat).match(/▎ ✓ read/g)).toHaveLength(2);
		click(f.chat, 1);
		f.chat.children.push(assistant(["c"], true), f.row("c"));
		expect(show(f.chat)).toContain("read ×3");
		expect(show(f.chat)).toContain("RESULT c");
		click(f.chat, 1);
		expect(show(f.chat)).not.toContain("RESULT c");
		expect(show(f.chat).match(/▎ ✓ read/g)).toHaveLength(3);
	});

	test("notifications captured before the first tool keep full text and never count", () => {
		const f = setup(false);
		f.notice("first notice");
		f.notice("second notice\ndetail", "warning");
		f.chat.children.push(assistant(["a", "b"]), f.row("a"), f.row("b"));
		expect(show(f.chat)).toContain("read ×2");
		expect(show(f.chat)).toContain("notify · first notice");
		expect(show(f.chat)).toContain("notify · Warning: second notice detail");
		expect(show(f.chat)).not.toContain("notify ×");
		click(f.chat, 1);
		expect(show(f.chat)).toContain("▎  detail");
		f.patch.dispose();
		f.notice("native after disposal");
		expect(show(f.chat)).toContain("native after disposal");
	});

	test("history replacement and theme invalidation use current nodes, not model projection", () => {
		const f = setup();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		click(f.chat, 1);
		expect(show(f.chat)).toContain("RESULT a");
		f.chat.clear();
		f.chat.children = [assistant(["c", "d"]), f.row("c", "grep"), f.row("d", "grep")];
		f.chat.invalidate();
		expect(show(f.chat)).toContain("▸ grep ×2");
		expect(show(f.chat)).not.toContain("RESULT");
	});

	test("narrow names remain width-safe and counts retain namespace identity", () => {
		const f = setup();
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
		expect(show(f.chat)).toContain("mcp__two__工具 ×1");
	});

	test("two owners share one hook and dispose independently; reinstall works", () => {
		const a = setup();
		const b = setup();
		const wrapper = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, seam)?.value;
		a.chat.children = [assistant(["a", "b"]), a.row("a"), a.row("b")];
		b.chat.children = [assistant(["c", "d"]), b.row("c"), b.row("d")];
		expect(show(a.chat)).toContain("×2");
		expect(show(b.chat)).toContain("×2");
		a.patch.dispose();
		expect(Object.getOwnPropertyDescriptor(InteractiveMode.prototype, seam)?.value).toBe(wrapper);
		expect(show(a.chat)).not.toContain("×2");
		expect(show(b.chat)).toContain("×2");
		b.patch.dispose();
		const again = installHostToolGroups(a.context);
		cleanups.push(again.dispose);
		expect(show(a.chat)).toContain("×2");
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
		// No additional tool lookup: history was already rebuilt before session_start.
		expect(show(f.chat)).toContain("read ×2");
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
});
