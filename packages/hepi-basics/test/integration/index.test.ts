import { expect, test } from "bun:test";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type EditorFactory = NonNullable<
	Parameters<NonNullable<ExtensionContext["ui"]["setEditorComponent"]>>[0]
>;
type Editor = ReturnType<EditorFactory>;
type FooterFactory = NonNullable<Parameters<NonNullable<ExtensionContext["ui"]["setFooter"]>>[0]>;

import piCavemanExtension, {
	CAVEMAN_SETTINGS_PROVIDER_ID,
} from "../../../hepi-skills/src/pi-caveman/index.js";
import piPonytailExtension, {
	PONYTAIL_SETTINGS_PROVIDER_ID,
} from "../../../hepi-skills/src/pi-ponytail/index.js";
import piBasicsExtension, {
	getHepiRuntimeModuleRegistry,
	getHepiRuntimeSettingsRegistry,
	type HepiModule,
	type HepiSettingField,
	type HepiSettingsProvider,
	registerHepiModule,
	registerHepiSettings,
} from "../../src/core/index.js";
import type { SettingsModule } from "../../src/core/ui/settings/index.js";

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await Bun.sleep(1);
}

function provider(
	id: string,
	closed: () => void,
	title: string = "Integration Provider",
): HepiSettingsProvider {
	const field: HepiSettingField<boolean> = {
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

function harness(mode: "tui" | "json" = "tui", waitForCustomDone = false) {
	const commands: Array<{
		name: string;
		handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	}> = [];
	const tools: string[] = [];
	const messageRenderers: string[] = [];
	const events = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<void>>>();
	const notifications: Array<{ message: string; level?: string }> = [];
	let customCalls = 0;
	let customDoneCalls = 0;
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
		events: createEventBus(),
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
		getSessionName: () => undefined,
		getAllTools: () => [],
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
				const completion = waitForCustomDone ? Promise.withResolvers<void>() : undefined;
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
					() => {
						customDoneCalls++;
						completion?.resolve();
					},
				);
				customComponent = component;
				rendered = component.render(100);
				await completion?.promise;
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
		get customDoneCalls() {
			return customDoneCalls;
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

test("accepts settings providers from mode extensions", async () => {
	const host = harness();
	piCavemanExtension(host.pi);
	piPonytailExtension(host.pi);
	piBasicsExtension(host.pi);
	const settingsRegistry = getHepiRuntimeSettingsRegistry(host.pi);
	await host.emit("session_start");
	expect(settingsRegistry.get(CAVEMAN_SETTINGS_PROVIDER_ID)?.origin).toBe("@hheei/hepi-skills");
	expect(settingsRegistry.get(PONYTAIL_SETTINGS_PROVIDER_ID)?.origin).toBe("@hheei/hepi-skills");
	await host.emit("session_shutdown");
	expect(settingsRegistry.get(CAVEMAN_SETTINGS_PROVIDER_ID)).toBeUndefined();
	expect(settingsRegistry.get(PONYTAIL_SETTINGS_PROVIDER_ID)).toBeUndefined();
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
	const unregister = registerHepiSettings(
		provider("integration-json", () => undefined),
		getHepiRuntimeSettingsRegistry(host.pi),
	);
	await host.commands.find(({ name }) => name === "ext-settings")!.handler("", host.ctx);
	expect(host.customCalls).toBe(0);
	expect(host.notifications[0]?.message).toContain("requires TUI mode");
	unregister();
	await host.emit("session_shutdown");
});

test("opens Settings with providers registered through public API and closes storage", async () => {
	let closed = 0;
	const host = harness("tui", true);
	piBasicsExtension(host.pi);
	await host.emit("session_start");
	const unregister = registerHepiSettings(
		provider("integration-tui", () => {
			closed++;
		}),
		getHepiRuntimeSettingsRegistry(host.pi),
	);
	const opening = host.commands.find(({ name }) => name === "ext-settings")!.handler("", host.ctx);
	await waitFor(() => host.rendered.length > 0);
	expect(host.customCalls).toBe(1);
	expect(host.rendered.length).toBeGreaterThan(0);
	host.inputCustom("\x1b");
	await opening;
	expect(host.customDoneCalls).toBe(1);
	expect(closed).toBe(1);
	unregister();
	await host.emit("session_shutdown");
	expect(closed).toBe(1);
});

test("closes Settings resources when provider loading fails", async () => {
	let closed = 0;
	const host = harness();
	piBasicsExtension(host.pi);
	registerHepiSettings(
		{
			...provider("integration-load-failure", () => {
				closed++;
			}),
			storage: {
				load: () => {
					throw new Error("load failed");
				},
				save: () => undefined,
				close: () => {
					closed++;
				},
			},
		},
		getHepiRuntimeSettingsRegistry(host.pi),
	);
	await host.emit("session_start");
	await host.commands.find(({ name }) => name === "ext-settings")!.handler("", host.ctx);
	expect(closed).toBe(1);
	expect(host.notifications.at(-1)?.message).toContain("load failed");
	await host.emit("session_shutdown");
});

test("shutdown waits for an active Loadout close", async () => {
	const gate = Promise.withResolvers<void>();
	let loadoutCloseStarted = false;
	const host = harness("tui", true);
	piBasicsExtension(host.pi);
	registerHepiModule(
		{
			id: "loadout",
			label: "Loadout",
			commands: [],
			open: () => undefined,
			createShellView: () => ({
				component: { render: () => ["LOADOUT VIEW"], invalidate: () => undefined },
				close: async () => {
					loadoutCloseStarted = true;
					await gate.promise;
				},
			}),
		},
		getHepiRuntimeModuleRegistry(host.pi),
	);
	await host.emit("session_start");
	const opening = host.commands.find(({ name }) => name === "ext-settings")!.handler("", host.ctx);
	await waitFor(() => host.rendered.length > 0);
	host.inputCustom("\x1b");
	await waitFor(() => loadoutCloseStarted);
	expect(loadoutCloseStarted).toBe(true);
	let shutdownSettled = false;
	const shutdown = host.emit("session_shutdown").finally(() => {
		shutdownSettled = true;
	});
	await Bun.sleep(0);
	expect(shutdownSettled).toBe(false);

	gate.resolve();
	await Promise.all([opening, shutdown]);
	expect(host.customDoneCalls).toBe(1);
});

test("session shutdown settles an open Settings shell and closes both views", async () => {
	let settingsClosed = 0;
	let loadoutClosed = 0;
	const host = harness("tui", true);
	piBasicsExtension(host.pi);
	registerHepiModule(
		{
			id: "loadout",
			label: "Loadout",
			commands: [],
			open: () => undefined,
			createShellView: () => ({
				component: { render: () => ["LOADOUT VIEW"], invalidate: () => undefined },
				close: () => {
					loadoutClosed++;
				},
			}),
		},
		getHepiRuntimeModuleRegistry(host.pi),
	);
	registerHepiSettings(
		provider("integration-shutdown", () => {
			settingsClosed++;
		}),
		getHepiRuntimeSettingsRegistry(host.pi),
	);
	await host.emit("session_start");
	const opening = host.commands.find(({ name }) => name === "ext-settings")!.handler("", host.ctx);
	await Bun.sleep(0);

	await host.emit("session_shutdown");
	await opening;
	expect(host.customDoneCalls).toBe(1);
	expect(settingsClosed).toBe(1);
	expect(loadoutClosed).toBe(1);
});

test("session shutdown waits for an opening Loadout view", async () => {
	const gate = Promise.withResolvers<void>();
	let settingsClosed = 0;
	let loadoutClosed = 0;
	const host = harness("tui", true);
	piBasicsExtension(host.pi);
	registerHepiModule(
		{
			id: "loadout",
			label: "Loadout",
			commands: [],
			open: () => undefined,
			createShellView: async () => {
				await gate.promise;
				return {
					component: { render: () => ["LOADOUT VIEW"], invalidate: () => undefined },
					close: () => {
						loadoutClosed++;
					},
				};
			},
		},
		getHepiRuntimeModuleRegistry(host.pi),
	);
	registerHepiSettings(
		provider("integration-opening", () => {
			settingsClosed++;
		}),
		getHepiRuntimeSettingsRegistry(host.pi),
	);
	await host.emit("session_start");
	const opening = host.commands.find(({ name }) => name === "ext-settings")!.handler("", host.ctx);
	await Bun.sleep(0);
	const shutdown = host.emit("session_shutdown");
	await Bun.sleep(0);
	expect(host.customDoneCalls).toBe(0);

	gate.resolve();
	await Promise.all([opening, shutdown]);
	expect(host.customDoneCalls).toBe(1);
	expect(settingsClosed).toBe(1);
	expect(loadoutClosed).toBe(1);
});

test("renders every registered provider in the unified Settings view", async () => {
	const host = harness();
	piBasicsExtension(host.pi);
	await host.emit("session_start");
	const settingsRegistry = getHepiRuntimeSettingsRegistry(host.pi);
	registerHepiSettings(
		provider("integration-first", () => undefined, "First Provider"),
		settingsRegistry,
	);
	registerHepiSettings(
		provider("integration-second", () => undefined, "Second Provider"),
		settingsRegistry,
	);
	await host.commands.find(({ name }) => name === "ext-settings")!.handler("", host.ctx);
	const screen = host.rendered.join("\n");
	expect(screen).toContain("pi-integration-first");
	const settingsModule = getHepiRuntimeModuleRegistry(host.pi).get("setting");
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
	registerHepiModule(
		{
			id: "loadout",
			label: "Loadout",
			commands: [],
			open: () => undefined,
			createShellView: () => ({
				component: { render: () => ["LOADOUT VIEW"], invalidate: () => undefined },
			}),
		},
		getHepiRuntimeModuleRegistry(host.pi),
	);
	await host.emit("session_start");
	await host.commands.find(({ name }) => name === "ext-settings")!.handler("", host.ctx);
	host.inputCustom("\x1b[C");
	expect(host.rendered.join("\n")).toContain("LOADOUT VIEW");
	await host.emit("session_shutdown");
});

test("routes package-level module registration", async () => {
	const opened: string[] = [];
	const module: HepiModule = {
		id: "integration-session-module",
		label: "Integration session module",
		commands: ["integration-probe"],
		open: async (args, ctx) => {
			opened.push(`${args}:${ctx.sessionId}`);
		},
	};
	const host = harness();
	const unregister = registerHepiModule(module, getHepiRuntimeModuleRegistry(host.pi));
	piBasicsExtension(host.pi);
	await host.emit("session_start");
	await host.commands
		.find(({ name }) => name === "hepi")!
		.handler("integration-probe payload", host.ctx);
	expect(opened).toEqual(["payload:integration-session"]);
	unregister();
	await host.emit("session_shutdown");
});
