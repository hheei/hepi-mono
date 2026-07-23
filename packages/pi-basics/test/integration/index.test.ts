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
	getHePiModule,
	type HePiModule,
	type HePiSettingField,
	type HePiSettingsProvider,
	registerHePiModule,
	registerHePiSettings,
	type SettingsModule,
} from "../../src/index.js";

function provider(
	id: string,
	closed: () => void,
	title: string = "Integration Provider",
): HePiSettingsProvider {
	const field: HePiSettingField<boolean> = {
		id: "enabled",
		label: "Enabled",
		type: "boolean",
		defaultValue: false,
		description: "Enable or disable the integration fixture provider during Settings tests.",
		parse: (value) => value === "true",
	};
	return {
		id,
		title,
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
	const messageRenderers: string[] = [];
	const events = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<void>>>();
	const notifications: Array<{ message: string; level?: string }> = [];
	let customCalls = 0;
	let getActiveToolsCalls = 0;
	let rendered: string[] = [];
	let customComponent:
		| { render(width: number): string[]; handleInput?(input: string): void; invalidate(): void }
		| undefined;
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
		registerMessageRenderer(type: string) {
			messageRenderers.push(type);
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
					tui: { requestRender(): void; terminal?: { rows: number } },
					theme: unknown,
					keybindings: unknown,
					done: (result: undefined) => void,
				) => { render(width: number): string[]; invalidate(): void },
			) {
				customCalls++;
				const component = await factory(
					{ requestRender() {}, terminal: { rows: 50 } },
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
				customComponent = component;
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
		messageRenderers,
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
		inputCustom(input: string) {
			customComponent?.handleInput?.(input);
			if (customComponent !== undefined) rendered = customComponent.render(100);
		},
		async emit(event: string) {
			for (const handler of events.get(event) ?? []) await handler({}, ctx);
		},
	};
}

test("registers commands and lifecycle handlers", () => {
	const host = harness();
	piBasicsExtension(host.pi);
	expect(host.commands.map((command) => command.name)).toEqual(["ext-settings", "loadout", "hepi"]);
	expect(host.getActiveToolsCalls).toBe(0);
	expect(host.tools).toEqual([]);
	expect(host.messageRenderers).toEqual([]);
	expect(host.events.get("session_start")).toHaveLength(1);
	expect(host.events.get("session_shutdown")).toHaveLength(1);
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
	expect(host.autocompleteProviders).toBe(0);
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

test("does not create custom component outside TUI", async () => {
	const host = harness("json");
	piBasicsExtension(host.pi);
	await host.emit("session_start");
	registerHePiSettings(provider("integration-json", () => undefined));
	await host.commands.find(({ name }) => name === "ext-settings")!.handler("", host.ctx);
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
	await host.commands.find(({ name }) => name === "ext-settings")!.handler("", host.ctx);
	expect(host.customCalls).toBe(1);
	expect(host.rendered.length).toBeGreaterThan(0);
	await host.emit("session_shutdown");
	expect(closed).toBe(1);
});

test("renders every registered provider in the unified Settings view", async () => {
	const host = harness();
	piBasicsExtension(host.pi);
	await host.emit("session_start");
	registerHePiSettings(provider("integration-first", () => undefined, "First Provider"));
	registerHePiSettings(provider("integration-second", () => undefined, "Second Provider"));
	await host.commands.find(({ name }) => name === "ext-settings")!.handler("", host.ctx);
	const screen = host.rendered.join("\n");
	expect(screen).toContain("pi-integration-first");
	const settingsModule = getHePiModule("setting");
	expect(settingsModule).toHaveProperty("controller");
	const groupTitles = (settingsModule as SettingsModule).controller?.provider?.groups.map(
		(group) => group.title,
	);
	expect(groupTitles).toContain("pi-integration-first");
	expect(groupTitles).toContain("pi-integration-second");
	await host.emit("session_shutdown");
});

test("sizes Settings from the terminal height", async () => {
	const host = harness();
	piBasicsExtension(host.pi);
	await host.emit("session_start");
	await host.commands.find(({ name }) => name === "ext-settings")!.handler("", host.ctx);
	expect(host.rendered).toHaveLength(17);
	await host.emit("session_shutdown");
});

test("switches from Settings to a late-registered Loadout view", async () => {
	const host = harness();
	piBasicsExtension(host.pi);
	registerHePiModule({
		id: "loadout",
		label: "Loadout",
		commands: [],
		open: () => undefined,
		createShellView: () => ({
			component: { render: () => ["LOADOUT VIEW"], invalidate: () => undefined },
		}),
	});
	await host.emit("session_start");
	await host.commands.find(({ name }) => name === "ext-settings")!.handler("", host.ctx);
	host.inputCustom("\x1b[C");
	expect(host.rendered.join("\n")).toContain("LOADOUT VIEW");
	await host.emit("session_shutdown");
});

test("routes package-level module registration", async () => {
	const opened: string[] = [];
	const module: HePiModule = {
		id: "integration-session-module",
		label: "Integration session module",
		commands: ["integration-probe"],
		open: async (args, ctx) => {
			opened.push(`${args}:${ctx.sessionId}`);
		},
	};
	registerHePiModule(module);
	const host = harness();
	piBasicsExtension(host.pi);
	await host.emit("session_start");
	await host.commands
		.find(({ name }) => name === "hepi")!
		.handler("integration-probe payload", host.ctx);
	expect(opened).toEqual(["payload:integration-session"]);
	await host.emit("session_shutdown");
});
