import { expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type ExtensionLifecycleContext,
	openExtensionPageRouter,
	registerExtensionPage,
	registerLoadoutResource,
} from "@hheei/pi-ext-core";
import type { LoadoutEngine } from "../src/engine.js";
import { createLoadoutPage } from "../src/page.js";

type SurfaceComponent = {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
	dispose?(): void;
};

type SurfaceOptions = {
	readonly overlay?: boolean;
	readonly overlayOptions?: unknown;
	readonly onHandle?: (handle: { setHidden(hidden: boolean): void }) => void;
};

function harness(): {
	readonly pi: ExtensionAPI;
	readonly command: ExtensionCommandContext;
	readonly components: Array<{ readonly component: SurfaceComponent }>;
	readonly customCalls: () => number;
	readonly surfaceOptions: Array<SurfaceOptions | undefined>;
	readonly hiddenStates: boolean[];
	readonly editorCalls: Array<{ readonly title: string; readonly prefill: string | undefined }>;
} {
	const components: Array<{ readonly component: SurfaceComponent }> = [];
	const surfaceOptions: Array<SurfaceOptions | undefined> = [];
	const hiddenStates: boolean[] = [];
	const editorCalls: Array<{ readonly title: string; readonly prefill: string | undefined }> = [];
	let calls = 0;
	const theme = {
		fg: (_role: string, value: string) => value,
		bold: (value: string) => value,
		border: (value: string) => value,
		dim: (value: string) => value,
		accent: (value: string) => value,
		muted: (value: string) => value,
	} as never;
	const events = {};
	const pi = {
		events,
		getAllTools: () => [
			{
				name: "read",
				description: "Read a file from the current workspace.",
				sourceInfo: { source: "builtin", scope: "user", origin: "top-level", path: "builtin" },
			},
			{
				name: "project_check",
				description: "Run the project-local check.",
				sourceInfo: {
					source: "extension",
					scope: "project",
					origin: "top-level",
					path: "project",
				},
			},
		],
		getCommands: () => [
			{
				name: "skill:review",
				description: "Review changed code.",
				source: "skill",
				sourceInfo: { source: "skill", scope: "user", origin: "top-level", path: "skill" },
			},
		],
	} as unknown as ExtensionAPI;
	const command = {
		mode: "tui",
		cwd: "/workspace",
		ui: {
			theme,
			notify: () => undefined,
			editor: async (title: string, prefill?: string) => {
				editorCalls.push({ title, prefill });
				return "edited body";
			},
			custom<T>(
				factory: (tui: never, t: never, keybindings: unknown, done: (value: T) => void) => unknown,
				options?: SurfaceOptions,
			): Promise<T> {
				calls++;
				surfaceOptions.push(options);
				return new Promise<T>((resolve) => {
					const component = factory(
						{ requestRender: () => undefined } as never,
						theme,
						undefined,
						resolve as never,
					) as SurfaceComponent;
					options?.onHandle?.({
						setHidden: (hidden) => hiddenStates.push(hidden),
					});
					components.push({ component });
				});
			},
		},
	} as unknown as ExtensionCommandContext;
	return {
		pi,
		command,
		components,
		customCalls: () => calls,
		surfaceOptions,
		hiddenStates,
		editorCalls,
	};
}

function fakeEngine(): LoadoutEngine {
	return {
		start: async () => undefined,
		dispose: () => undefined,
		snapshot: () => ({
			configuration: {
				global: { disabled: [], enabled: [] },
				project: { disabled: [], enabled: [] },
			},
			initialActiveToolNames: ["read"],
		}),
	};
}

async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

test("native editor hides and restores overlay without losing detail scope", async () => {
	const h = harness();
	let detailScope = "global";
	let body = "initial body";
	const detail = {
		render: () => [`Scope: ${detailScope}`, `Body: ${body}`],
		onScopeChange: (scope: "global" | "project") => {
			detailScope = scope;
		},
		handleInput: async (
			input: string,
			context: { openEditor(title: string, prefill?: string): Promise<string | undefined> },
		) => {
			if (input === "e") body = (await context.openEditor("Body", body)) ?? body;
			return input !== "\u001b";
		},
	};
	const disposeResource = registerLoadoutResource(h.pi, {
		id: "agent:Editor",
		kind: "agent",
		group: "𖠌 Agents",
		priority: 0,
		conflictSets: [],
		defaultActive: true,
		label: "Editor",
		description: "Uses the native editor.",
		summary: "settings",
		projectPrivate: false,
		owner: "test",
		detail,
	});
	const context = {
		pi: h.pi,
		extension: {} as ExtensionContext,
		signal: new AbortController().signal,
		resources: { add: () => () => undefined },
	} as unknown as ExtensionLifecycleContext;
	registerExtensionPage(context, {
		id: "loadout",
		label: "Loadout",
		order: 0,
		create: async (viewContext) => createLoadoutPage(h.pi, fakeEngine(), viewContext),
	});
	try {
		const first = openExtensionPageRouter(h.pi, h.command, {
			hostId: "loadout-editor",
			signal: new AbortController().signal,
			maxPending: 1,
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", anchor: "bottom-left", margin: 0 },
		});
		await tick();
		const component = h.components[0]!.component;
		const drive = async (data: string): Promise<void> => {
			component.handleInput?.(data);
			await tick();
		};
		await drive("\u001b[112;5u");
		for (let index = 0; index < 8; index++) await drive("\u001b[B");
		await drive(" ");
		await drive("\r");
		expect(component.render(100).join("\n")).toContain("Scope: project");
		await drive("e");
		expect(h.hiddenStates).toEqual([true, false]);
		expect(h.editorCalls).toEqual([{ title: "Body", prefill: "initial body" }]);
		expect(h.customCalls()).toBe(1);
		expect(component.render(100).join("\n")).toContain("Scope: project");
		expect(component.render(100).join("\n")).toContain("Body: edited body");
		await drive("\u001b");
		await drive("\u001b");
		await first;
	} finally {
		disposeResource();
	}
});
