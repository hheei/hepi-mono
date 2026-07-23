import { expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type EditorFactory = NonNullable<
	Parameters<NonNullable<ExtensionContext["ui"]["setEditorComponent"]>>[0]
>;
type Editor = ReturnType<EditorFactory>;
type FooterFactory = NonNullable<Parameters<NonNullable<ExtensionContext["ui"]["setFooter"]>>[0]>;

import piBasicsExtension, {
	type HePiModule,
	type HePiSettingField,
	type HePiSettingsProvider,
	registerHePiModule,
	registerHePiSettings,
} from "../../src/index.js";

function provider(id: string, closed: () => void): HePiSettingsProvider {
	const field: HePiSettingField<boolean> = {
		id: "enabled",
		label: "Enabled",
		type: "boolean",
		defaultValue: false,
		parse: (value) => value === "true",
	};
	return {
		id,
		title: "Integration Provider",
		groups: [{ id: "general", title: "General", fields: [field] }],
		storage: {
			load: async () => ({}),
			save: async () => undefined,
			close: async () => {
				closed();
			},
		},
	};
}

function harness(mode: "tui" | "json" = "tui") {
	const commands: Array<{
		name: string;
		handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	}> = [];
	const tools: string[] = [];
	const events = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<void>>>();
	const notifications: Array<{ message: string; level?: string }> = [];
	let customCalls = 0;
	let getActiveToolsCalls = 0;
	let rendered: string[] = [];
	let footerFactory: FooterFactory | undefined;
	let footerRestores = 0;
	let editorFactory: EditorFactory | undefined;
	let autocompleteProviders = 0;
	const pi = {
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		registerCommand(
			name: string,
			options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) {
			commands.push({ name, handler: options.handler });
		},
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) {
			const handlers = events.get(event) ?? [];
			handlers.push(handler);
			events.set(event, handlers);
		},
		getActiveTools: () => {
			getActiveToolsCalls++;
			return tools;
		},
		setActiveTools(next: string[]) {
			tools.splice(0, tools.length, ...next);
		},
		getThinkingLevel: () => "low" as const,
		getCommands: () => [
			{
				name: "skill:librarian",
				description: "Research libraries",
				source: "skill" as const,
				sourceInfo: {
					path: "/skills/librarian/SKILL.md",
					source: "fixture",
					scope: "user" as const,
					origin: "top-level" as const,
				},
			},
		],
	} as unknown as ExtensionAPI;
	const ctx = {
		mode,
		hasUI: mode === "tui",
		cwd: "/tmp/pi-basics",
		signal: undefined,
		model: { id: "model", name: "Model" },
		getContextUsage: () => ({ percent: 50, contextWindow: 1000 }),
		ui: {
			theme: { fg: (_role: string, text: string) => text },
			addAutocompleteProvider() {
				autocompleteProviders++;
			},
			getEditorComponent() {
				return editorFactory;
			},
			setEditorComponent(factory: EditorFactory | undefined) {
				editorFactory = factory;
			},
			notify(message: string, level?: string) {
				notifications.push(level === undefined ? { message } : { message, level });
			},
			setStatus() {},
			setFooter(factory: FooterFactory | undefined) {
				if (factory) footerFactory = factory;
				else footerRestores++;
			},
			async custom(
				factory: (
					tui: { requestRender(): void },
					theme: unknown,
					keybindings: unknown,
					done: (result: undefined) => void,
				) => { render(width: number): string[]; invalidate(): void },
			) {
				customCalls++;
				const component = factory(
					{ requestRender() {} },
					{
						fg: (_color: string, text: string) => text,
						bold: (text: string) => text,
						dim: (text: string) => text,
						italic: (text: string) => text,
						strikethrough: (text: string) => text,
					},
					{},
					() => undefined,
				);
				rendered = component.render(100);
				return undefined;
			},
		},
		sessionManager: {
			getSessionId: () => "integration-session",
			getBranch: () => [],
			getSessionName: () => "Integration",
		},
	} as unknown as ExtensionContext & ExtensionCommandContext;
	return {
		pi,
		ctx,
		commands,
		tools,
		events,
		notifications,
		get footerFactory() {
			return footerFactory;
		},
		get footerRestores() {
			return footerRestores;
		},
		get customCalls() {
			return customCalls;
		},
		get getActiveToolsCalls() {
			return getActiveToolsCalls;
		},
		get autocompleteProviders() {
			return autocompleteProviders;
		},
		get rendered() {
			return rendered;
		},
		async emit(event: string) {
			for (const handler of events.get(event) ?? []) await handler({}, ctx);
		},
	};
}

test("registers commands and lifecycle handlers", () => {
	const host = harness();
	piBasicsExtension(host.pi);
	expect(host.commands.map((command) => command.name)).toEqual([
		"rtk",
		"goal",
		"todos",
		"plan",
		"hepi",
	]);
	expect(host.getActiveToolsCalls).toBe(0);
	expect(host.tools).toEqual(["goal", "ask", "todo", "sshfs"]);
	expect(host.events.get("session_start")).toHaveLength(3);
	expect(host.events.get("session_shutdown")).toHaveLength(2);
});

test("installs and restores footer and editor seams for TUI session", async () => {
	const host = harness("tui");
	const calls: string[] = [];
	const previous: EditorFactory = (..._args): Editor => ({
		render: () => ["original-top", "PROMPT HERE", "original-bottom", "original-autocomplete"],
		invalidate: () => undefined,
		getText: () => "original-text",
		setText: () => undefined,
		handleInput: (data: string) => calls.push(data),
	});
	host.ctx.ui.setEditorComponent(previous);
	piBasicsExtension(host.pi);
	expect(host.getActiveToolsCalls).toBe(0);
	await host.emit("session_start");
	expect(host.getActiveToolsCalls).toBe(1);
	expect(host.autocompleteProviders).toBe(1);
	expect(host.footerFactory).toBeDefined();
	expect(
		host.footerFactory!({ requestRender: () => undefined } as never, host.ctx.ui.theme, {
			getExtensionStatuses: () => new Map(),
		} as never).render(80),
	).toEqual([]);
	const editor = host.ctx.ui.getEditorComponent()!({} as never, {} as never, {} as never);
	const lines = editor.render(80);
	expect(lines).toHaveLength(4);
	expect(lines[0]).not.toBe("original-top");
	expect(lines.slice(1)).toEqual(["PROMPT HERE", "original-bottom", "original-autocomplete"]);
	editor.handleInput("typed");
	expect(calls).toEqual(["typed"]);
	expect(editor.getText()).toBe("original-text");
	await host.emit("session_shutdown");
	expect(host.footerRestores).toBe(1);
	expect(host.ctx.ui.getEditorComponent()).toBe(previous);
	await host.emit("session_shutdown");
	expect(host.footerRestores).toBe(1);
});

test("opens built-in automatic title settings without external providers", async () => {
	const host = harness();
	piBasicsExtension(host.pi);
	await host.emit("session_start");
	await host.commands.find(({ name }) => name === "hepi")!.handler("setting", host.ctx);
	const rendered = host.rendered.join("\n");
	expect(host.customCalls).toBe(1);
	expect(rendered).toContain("⚙ Settings");
	expect(rendered).toContain("◈ Loadout");
	expect(rendered).toContain("auto title");
	expect(rendered).toContain("title model");
	expect(rendered).toContain("RTK");
	expect(rendered).toContain("Dollar skill references");
	expect(rendered).not.toContain("traditional to simplified");
	expect(rendered).toContain("Origin: @pi-basics");
	expect(host.notifications).toEqual([]);
	await host.emit("session_shutdown");
});

test("does not create custom component outside TUI", async () => {
	const host = harness("json");
	piBasicsExtension(host.pi);
	await host.emit("session_start");
	registerHePiSettings(provider("integration-json", () => undefined));
	await host.commands.find(({ name }) => name === "hepi")!.handler("setting", host.ctx);
	expect(host.customCalls).toBe(0);
	expect(host.notifications[0]?.message).toContain("requires TUI mode");
	await host.emit("session_shutdown");
});

test("opens Settings with providers registered through public API and closes storage", async () => {
	let closed = 0;
	const host = harness();
	piBasicsExtension(host.pi);
	await host.emit("session_start");
	registerHePiSettings(
		provider("integration-tui", () => {
			closed++;
		}),
	);
	await host.commands.find(({ name }) => name === "hepi")!.handler("setting", host.ctx);
	expect(host.customCalls).toBe(1);
	expect(host.rendered.join("\n")).toContain("⚙ Settings");
	expect(host.rendered.join("\n")).toContain("◈ Loadout");
	await host.emit("session_shutdown");
	expect(closed).toBe(1);
});

test("routes public module registration through active session registry", async () => {
	const first = harness();
	piBasicsExtension(first.pi);
	const opened: string[] = [];
	const module = (id: string): HePiModule => ({
		id,
		label: id,
		commands: ["probe"],
		open: async (args, ctx) => {
			opened.push(`${id}:${args}:${ctx.sessionId}`);
		},
	});

	expect(() => registerHePiModule(module("before"))).toThrow("active session");
	await first.emit("session_start");
	registerHePiModule(module("session-module"));
	await first.commands.find(({ name }) => name === "hepi")!.handler("probe payload", first.ctx);
	expect(opened).toEqual(["session-module:payload:integration-session"]);
	await first.emit("session_shutdown");
	expect(() => registerHePiModule(module("after"))).toThrow("active session");

	const second = harness();
	piBasicsExtension(second.pi);
	await second.emit("session_start");
	registerHePiModule(module("session-module"));
	await second.commands.find(({ name }) => name === "hepi")!.handler("probe second", second.ctx);
	expect(opened).toEqual([
		"session-module:payload:integration-session",
		"session-module:second:integration-session",
	]);
	await second.emit("session_shutdown");
});
