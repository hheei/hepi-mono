import { expect, test } from "bun:test";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getHepiRuntimeSettingsRegistry } from "@hheei/pi-ext-core";

type EditorFactory = NonNullable<
	Parameters<NonNullable<ExtensionContext["ui"]["setEditorComponent"]>>[0]
>;
type Editor = ReturnType<EditorFactory>;
type FooterFactory = NonNullable<Parameters<NonNullable<ExtensionContext["ui"]["setFooter"]>>[0]>;

import piCavemanExtension, { CAVEMAN_SETTINGS_PROVIDER_ID } from "../../../pi-caveman/src/index.js";
import piPonytailExtension, {
	PONYTAIL_SETTINGS_PROVIDER_ID,
} from "../../../pi-ponytail/src/index.js";
import piBasicsExtension from "../../src/core/index.js";

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

test("registers lifecycle handlers without legacy settings commands", () => {
	const host = harness();
	piBasicsExtension(host.pi);
	expect(host.commands).toEqual([]);
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
	expect(settingsRegistry.get(CAVEMAN_SETTINGS_PROVIDER_ID)?.origin).toBe("@hheei/pi-caveman");
	expect(settingsRegistry.get(PONYTAIL_SETTINGS_PROVIDER_ID)?.origin).toBe("@hheei/pi-ponytail");
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
	).toEqual([expect.stringContaining("/tmp/pi-basics")]);
	const editor = host.ctx.ui.getEditorComponent()!({} as never, {} as never, {} as never);
	const lines = editor.render(80);
	expect(lines).toHaveLength(4);
	expect(lines[0]).not.toBe("original-top");
	expect(lines.slice(1)).toEqual(["PROMPT HERE", "original-bottom", "original-autocomplete"]);
	editor.handleInput("typed");
	expect(calls).toEqual(["typed"]);
	expect(editor.getText()).toBe("original-text");
	host.ctx.ui.setFooter(undefined);
	host.ctx.ui.setEditorComponent(undefined);
	await host.emit("session_shutdown");
	expect(host.footerRestores).toBe(1);
	expect(host.ctx.ui.getEditorComponent()).toBeUndefined();
	await host.emit("session_shutdown");
	expect(host.footerRestores).toBe(1);
});
