import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { createAgentDetail } from "../../pi-subagents/src/agent-detail.js";
import type { AgentConfig } from "../../pi-subagents/src/types.js";
import type { LoadoutEngine } from "../src/engine.js";
import { createLoadoutPage } from "../src/page.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

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

test("Esc through the agent detail keeps the router surface closeable and reopenable", async () => {
	const h = harness();
	const root = await mkdtemp(join(tmpdir(), "pi-loadout-router-"));
	temporaryRoots.push(root);
	const agentsDir = join(root, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, "Explore.md"),
		"---\ndescription: Read-only explorer.\n---\nYou are read-only.\n",
	);
	const config: AgentConfig = {
		name: "Explore",
		description: "Read-only explorer.",
		extensions: true,
		skills: true,
		systemPrompt: "You are read-only.",
		promptMode: "replace",
		source: "project",
	};
	const detail = createAgentDetail(
		"Explore",
		config,
		undefined,
		() => undefined,
		() => undefined,
	);
	const disposeResource = registerLoadoutResource(h.pi, {
		id: "agent:Explore",
		kind: "agent",
		group: "𖠌 Agents",
		priority: 0,
		conflictSets: [],
		defaultActive: true,
		label: "Explore",
		description: "Read-only explorer.",
		summary: "inherit",
		projectPrivate: false,
		owner: "@hheei/pi-subagents",
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
		// First open: drive the real router surface through the agent detail.
		const firstSignal = new AbortController().signal;
		const first = openExtensionPageRouter(h.pi, h.command, {
			hostId: "loadout",
			signal: firstSignal,
			maxPending: 1,
		});
		await tick();
		const firstComponent = h.components[0]!.component;

		const drive = async (data: string): Promise<void> => {
			firstComponent.handleInput?.(data);
			await tick();
		};
		// Select the agent and open its detail.
		await drive("\u001b[B");
		await drive("\u001b[B"); // read → project_check → Explore
		expect(firstComponent.render(100).join("\n")).toContain("● Explore");
		await drive("\r"); // open the detail
		expect(firstComponent.render(100).join("\n")).toContain("Identity");
		// Esc backs out of the detail, then closes the router surface — never
		// leaving the TUI stuck.
		await drive("\u001b"); // detail → list
		await drive("\u001b"); // router close
		await first;
		await tick();

		// A second open after editing keys inside the detail also closes cleanly.
		const secondSignal = new AbortController().signal;
		const second = openExtensionPageRouter(h.pi, h.command, {
			hostId: "loadout",
			signal: secondSignal,
			maxPending: 1,
		});
		await tick();
		expect(h.customCalls()).toBe(2);
		const secondComponent = h.components[1]!.component;
		expect(secondComponent.render(100).join("\n")).toContain("Loadout");
		secondComponent.handleInput?.("\u001b");
		await second;
	} finally {
		disposeResource();
	}
});

test("typing in the detail then closing keeps the surface reopenable", async () => {
	const h = harness();
	const root = await mkdtemp(join(tmpdir(), "pi-loadout-router-"));
	temporaryRoots.push(root);
	const agentsDir = join(root, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, "Explore.md"),
		"---\ndescription: Read-only explorer.\n---\nYou are read-only.\n",
	);
	const config: AgentConfig = {
		name: "Explore",
		description: "Read-only explorer.",
		extensions: true,
		skills: true,
		systemPrompt: "You are read-only.",
		promptMode: "replace",
		source: "project",
	};
	const detail = createAgentDetail(
		"Explore",
		config,
		undefined,
		() => undefined,
		() => undefined,
	);
	const disposeResource = registerLoadoutResource(h.pi, {
		id: "agent:Explore",
		kind: "agent",
		group: "𖠌 Agents",
		priority: 0,
		conflictSets: [],
		defaultActive: true,
		label: "Explore",
		description: "Read-only explorer.",
		summary: "inherit",
		projectPrivate: false,
		owner: "@hheei/pi-subagents",
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
		const firstSignal = new AbortController().signal;
		const first = openExtensionPageRouter(h.pi, h.command, {
			hostId: "loadout",
			signal: firstSignal,
			maxPending: 1,
		});
		await tick();
		const firstComponent = h.components[0]!.component;
		const drive = async (data: string): Promise<void> => {
			firstComponent.handleInput?.(data);
			await tick();
		};
		await drive("\u001b[B");
		await drive("\u001b[B");
		await drive("\r"); // open the detail
		await drive("x"); // buffer an identity edit
		await drive("\u001b"); // detail → list
		await drive("\u001b"); // router close
		await first;
		await tick();

		// Second open succeeds: the first surface fully released its slot.
		const secondSignal = new AbortController().signal;
		const second = openExtensionPageRouter(h.pi, h.command, {
			hostId: "loadout",
			signal: secondSignal,
			maxPending: 1,
		});
		await tick();
		expect(h.customCalls()).toBe(2);
		const secondComponent = h.components[1]!.component;
		expect(secondComponent.render(100).join("\n")).toContain("Loadout");
		secondComponent.handleInput?.("\u001b");
		await second;
	} finally {
		disposeResource();
	}
});

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
