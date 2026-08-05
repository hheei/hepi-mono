import { afterEach, describe, expect, test, vi } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	type ExtensionPageViewContext,
	type LoadoutResourceDetailContext,
	type PiSettingsPaths,
	registerLoadoutInventory,
	registerLoadoutResource,
	registerManagedLoadoutTool,
	registerManagedTool,
} from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { replayTui, viewFrame } from "../../pi-debug/src/tui-replay.js";
import { type AgentDetail, createAgentDetail } from "../../pi-subagents/src/agent-detail.js";
import type { AgentConfig } from "../../pi-subagents/src/types.js";
import type { LoadoutEngine } from "../src/engine.js";
import { createLoadoutPage } from "../src/page.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function paths(): Promise<PiSettingsPaths> {
	const root = await mkdtemp(join(tmpdir(), "pi-loadout-page-"));
	temporaryRoots.push(root);
	return { globalPath: join(root, "agent.json"), projectPath: join(root, "project.json") };
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

function setup(): {
	readonly pi: ExtensionAPI;
	readonly context: ExtensionPageViewContext;
	readonly notifications: Array<{ readonly message: string; readonly type: string | undefined }>;
	readonly closes: { value: number };
	readonly editors: Array<{ readonly title: string; readonly prefill: string | undefined }>;
	readonly tools: ToolInfo[];
} {
	const notifications: Array<{ readonly message: string; readonly type: string | undefined }> = [];
	const closes = { value: 0 };
	const editors: Array<{ readonly title: string; readonly prefill: string | undefined }> = [];
	const tools: ToolInfo[] = [
		{
			name: "read",
			description: "Read a file from the current workspace.",
			parameters: Type.Object({}),
			sourceInfo: { source: "builtin", scope: "user", origin: "top-level", path: "builtin" },
		},
		{
			name: "project_check",
			description: "Run the project-local check.",
			parameters: Type.Object({}),
			sourceInfo: {
				source: "extension",
				scope: "project",
				origin: "top-level",
				path: "project",
			},
		},
	];
	const pi = {
		events: {},
		registerTool: () => undefined,
		getAllTools: () => tools,
		getCommands: () => [
			{
				name: "skill:review",
				description: "Review changed code.",
				source: "skill",
				sourceInfo: { source: "skill", scope: "user", origin: "top-level", path: "skill" },
			},
		],
	} as unknown as ExtensionAPI;
	const theme = {
		fg: (_role: string, value: string) => value,
		bold: (value: string) => value,
	} as never;
	const context = {
		command: {
			cwd: "/workspace",
			ui: {
				notify: (message: string, type?: "info" | "warning") =>
					notifications.push({ message, type }),
			},
		} as never,
		signal: new AbortController().signal,
		theme,
		requestRender: () => undefined,
		openEditor: async (title: string, prefill?: string) => {
			editors.push({ title, prefill });
			return undefined;
		},
		requestClose: () => {
			closes.value++;
		},
	} as ExtensionPageViewContext;
	return { pi, context, notifications, closes, editors, tools };
}

describe("Loadout Settings page", () => {
	test("hides unpublished managed tools and keeps published forced tools read-only", async () => {
		const h = setup();
		h.tools.push({
			name: "ctx_reduce",
			description: "Reduce MCTX history.",
			parameters: Type.Object({}),
			sourceInfo: { source: "extension", scope: "user", origin: "top-level", path: "mctx" },
		});
		registerManagedTool(h.pi, { id: "ctx_reduce", owner: "@hheei/pi-mctx" }, {
			name: "ctx_reduce",
		} as never);
		const page = createLoadoutPage(h.pi, fakeEngine(), h.context);
		expect(page.component.render(100).join("\n")).not.toContain("ctx_reduce");
		const cleanups: Array<() => void | Promise<void>> = [];
		const resources = {
			add(_key: string, cleanup: () => void | Promise<void>): void {
				cleanups.push(cleanup);
			},
		};
		registerLoadoutInventory({ pi: h.pi, resources } as never, {
			id: "ctx_reduce",
			group: "Magic Context",
			priority: 0,
			conflictSets: [],
			defaultActive: true,
			forcedActive: true,
		});
		expect(page.component.render(100).join("\n")).toContain("ctx_reduce");
		await page.handleInput("\u001b[B");
		expect(page.component.render(100).join("\n")).toContain("Status: ● Forced active");
		await page.handleInput(" ");
		expect(page.component.render(100).join("\n")).toContain("Status: ● Forced active");
		for (const cleanup of cleanups) await cleanup();
	});

	test("renders one selected-resource Description block and hides project-private rows globally", async () => {
		const h = setup();
		const page = createLoadoutPage(h.pi, fakeEngine(), h.context);
		const global = page.component.render(100).join("\n");
		const resourceLine = global
			.split("\n")
			.find((line) => line.includes("●") && line.includes("Built-in"));
		expect(resourceLine?.indexOf("Built-in")).toBeLessThan(20);
		const replay = await replayTui({
			columns: 100,
			rows: 20,
			create: () => page.component,
			actions: [],
		});
		const frame = viewFrame(replay.last);
		expect(frame).toHaveLength(20);
		const replayResourceLine = frame.find(
			(line) => line.includes("●") && line.includes("Built-in"),
		);
		expect(replayResourceLine?.indexOf("Built-in")).toBeLessThan(20);
		expect(global).toContain("⚒ Tools");
		expect(global).toContain("read (tool)");
		expect(global).toContain("Read a file from the current workspace.");
		expect(global).toContain("Origin: Pi built-in");
		expect(global).toContain("Status: ● Active");
		expect(global).not.toContain("Effective:");
		expect(global).not.toContain("Policy:");
		expect(global).not.toContain("This scope:");
		expect(global).not.toContain("Default:");
		expect(global).not.toContain("project_check");
		await page.handleInput("\u001b[112;5u");
		const project = page.component.render(100).join("\n");
		expect(project).toContain("Project · /workspace/.pi/settings.json");
		expect(project).toContain("project_check");
		expect(project.indexOf("read")).toBeLessThan(project.indexOf("project_check"));
	});

	test("renders registered agents after skills with activation and model summary", () => {
		const h = setup();
		const dispose = registerLoadoutResource(h.pi, {
			id: "agent:Explore",
			kind: "agent",
			group: "𖠌 Agents",
			priority: 0,
			conflictSets: [],
			defaultActive: true,
			label: "Explore",
			description: "Read-only explorer.",
			summary: "◔ cx/gpt-5.6-luna",
			projectPrivate: false,
			owner: "@hheei/pi-subagents",
		});
		const page = createLoadoutPage(h.pi, fakeEngine(), h.context);
		const output = page.component.render(100).join("\n");
		expect(output).toContain("⚒ Tools");
		expect(output).toContain("✦ Skills");
		expect(output).toContain("𖠌 Agents");
		expect(output).toContain("● Explore");
		expect(output).toContain("◔ cx/gpt-5.6-luna");
		expect(output.indexOf("✦ Skills")).toBeLessThan(output.indexOf("𖠌 Agents"));
		// No detail contribution → no Edit config affordance in the Description lane.
		expect(output).not.toContain("↵ Edit config");
		dispose();
	});

	test("prefers a tool owner's precise origin over host source categories", () => {
		const h = setup();
		registerManagedLoadoutTool(
			h.pi,
			{
				id: "read",
				owner: "@hheei/pi-ext-tools",
				group: "Built-in",
				origin: "@hheei/pi-ext-tools",
				priority: 100,
				conflictSets: [],
				defaultActive: true,
			},
			{ name: "read" } as never,
		);
		const page = createLoadoutPage(h.pi, fakeEngine(), h.context);
		const output = page.component.render(100).join("\n");
		expect(output).toContain("Origin: @hheei/pi-ext-tools");
	});

	test("enters registered resource detail, routes input, and exits with Escape", async () => {
		const h = setup();
		const inputs: string[] = [];
		const dispose = registerLoadoutResource(h.pi, {
			id: "agent:Detail",
			kind: "agent",
			group: "𖠌 Agents",
			priority: 0,
			conflictSets: [],
			defaultActive: true,
			label: "Detail",
			description: "Has a settings detail.",
			summary: "settings",
			projectPrivate: false,
			owner: "test",
			detail: {
				render: (width) => [`Detail panel ${width}`],
				handleInput: (input) => {
					inputs.push(input);
					return input !== "\u001b"; // decline Esc so the page backs out
				},
			},
		});
		try {
			const page = createLoadoutPage(h.pi, fakeEngine(), h.context);
			expect(page.component.render(100).join("\n")).toContain("↵");
			await page.handleInput("\u001b[B");
			await page.handleInput("\u001b[B");
			await page.handleInput("\r");
			const opened = page.component.render(100).join("\n");
			expect(opened).toContain("Detail (agent)");
			expect(opened).toContain("Origin: test");
			expect(opened).toContain("Status: ● Active");
			expect(opened).toContain("Detail panel");
			await page.handleInput("x");
			expect(inputs).toEqual(["x"]);
			await page.handleInput("\u001b");
			expect(inputs).toEqual(["x", "\u001b"]);
			const back = page.component.render(100).join("\n");
			expect(back).not.toContain("Detail panel");
		} finally {
			dispose();
		}
	});

	test("keeps the detail open while the detail consumes Escape", async () => {
		const h = setup();
		const dispose = registerLoadoutResource(h.pi, {
			id: "agent:Detail",
			kind: "agent",
			group: "𖠌 Agents",
			priority: 0,
			conflictSets: [],
			defaultActive: true,
			label: "Detail",
			description: "Has a settings detail.",
			summary: "settings",
			projectPrivate: false,
			owner: "test",
			detail: {
				render: () => ["Detail panel"],
				handleInput: () => true,
			},
		});
		try {
			const page = createLoadoutPage(h.pi, fakeEngine(), h.context);
			await page.handleInput("\u001b[B");
			await page.handleInput("\u001b[B");
			await page.handleInput("\r");
			expect(page.component.render(100).join("\n")).toContain("Detail panel");
			await page.handleInput("\u001b");
			expect(page.component.render(100).join("\n")).toContain("Detail panel");
		} finally {
			dispose();
		}
	});

	test("keeps wheel navigation in the resource list while a detail is open", async () => {
		const h = setup();
		const inputs: string[] = [];
		const disposeDetail = registerLoadoutResource(h.pi, {
			id: "agent:Detail",
			kind: "agent",
			group: "𖠌 Agents",
			priority: 0,
			conflictSets: [],
			defaultActive: true,
			label: "Detail",
			description: "Has a settings detail.",
			summary: "settings",
			projectPrivate: false,
			owner: "test",
			detail: {
				render: () => ["Detail panel"],
				handleInput: (input) => {
					inputs.push(input);
					return input !== "\u001b";
				},
			},
		});
		const disposeZulu = registerLoadoutResource(h.pi, {
			id: "agent:Zulu",
			kind: "agent",
			group: "𖠌 Agents",
			priority: 0,
			conflictSets: [],
			defaultActive: true,
			label: "Zulu",
			description: "Second resource.",
			summary: "settings",
			projectPrivate: false,
			owner: "test",
		});
		try {
			const page = createLoadoutPage(h.pi, fakeEngine(), h.context);
			await page.handleInput("\u001b[B");
			await page.handleInput("\u001b[B");
			await page.handleInput("\r");
			await page.handleInput("\x1b[<65;1;1M"); // SGR wheel down
			expect(inputs).toEqual([]);
			await page.handleInput("\u001b");
			expect(page.component.render(100).join("\n")).toContain("Zulu (agent)");
		} finally {
			disposeDetail();
			disposeZulu();
		}
	});

	test("forwards one stable editor context to every active detail input", async () => {
		const h = setup();
		const inputs: string[] = [];
		const contexts: LoadoutResourceDetailContext[] = [];
		const dispose = registerLoadoutResource(h.pi, {
			id: "agent:Editor",
			kind: "agent",
			group: "𖠌 Agents",
			priority: 0,
			conflictSets: [],
			defaultActive: true,
			label: "Editor",
			description: "Has an editor action.",
			summary: "settings",
			projectPrivate: false,
			owner: "test",
			detail: {
				render: () => ["Detail panel"],
				handleInput: async (input, context) => {
					inputs.push(input);
					contexts.push(context);
					if (input === "e") await context.openEditor("Body", "draft body");
					return input !== "\u001b";
				},
			},
		});
		try {
			const page = createLoadoutPage(h.pi, fakeEngine(), h.context);
			await page.handleInput("\u001b[B");
			await page.handleInput("\u001b[B");
			await page.handleInput("\r");
			await page.handleInput("e");
			await page.handleInput("\u001b");
			expect(inputs).toEqual(["e", "\u001b"]);
			expect(contexts).toHaveLength(2);
			expect(contexts[0]).toBe(contexts[1]);
			expect(h.editors).toEqual([{ title: "Body", prefill: "draft body" }]);
			expect(page.component.render(100).join("\n")).not.toContain("Detail panel");
		} finally {
			dispose();
		}
	});

	test("inherited and disabled agent rows get no edit path", async () => {
		const h = setup();
		const inputs: string[] = [];
		const dispose = registerLoadoutResource(h.pi, {
			id: "agent:Detail",
			kind: "agent",
			group: "𖠌 Agents",
			priority: 0,
			conflictSets: [],
			defaultActive: true,
			label: "Detail",
			description: "Has a settings detail.",
			summary: "settings",
			projectPrivate: false,
			owner: "test",
			detail: {
				render: () => ["Detail panel"],
				handleInput: (input) => {
					inputs.push(input);
					return true;
				},
			},
		});
		try {
			// Disabled: a global delta disables the row, so the hint is gone and
			// Enter must not open the detail.
			const disabledEngine: LoadoutEngine = {
				start: async () => undefined,
				dispose: () => undefined,
				snapshot: () => ({
					configuration: {
						global: { disabled: ["agent:Detail"], enabled: [] },
						project: { disabled: [], enabled: [] },
					},
					initialActiveToolNames: ["read"],
				}),
			};
			const disabled = createLoadoutPage(h.pi, disabledEngine, h.context);
			await disabled.handleInput("\u001b[B");
			await disabled.handleInput("\u001b[B");
			expect(disabled.component.render(100).join("\n")).not.toContain("↵");
			await disabled.handleInput("\r");
			expect(disabled.component.render(100).join("\n")).not.toContain("Detail panel");
			// Inherited: project scope with no project-private row and no delta.
			const inherited = createLoadoutPage(h.pi, fakeEngine(), h.context);
			await inherited.handleInput("\u001b[112;5u"); // ctrl+p → project
			await inherited.handleInput("\u001b[B");
			await inherited.handleInput("\u001b[B");
			const project = inherited.component.render(100).join("\n");
			expect(project).toContain("Project · /workspace/.pi/settings.json");
			expect(project).not.toContain("↵");
			await inherited.handleInput("\r");
			expect(inherited.component.render(100).join("\n")).not.toContain("Detail panel");
			expect(inputs).toEqual([]);
		} finally {
			dispose();
		}
	});

	test("renders enabled, disabled, and inherited agent states distinctly", async () => {
		const h = setup();
		const dispose = registerLoadoutResource(h.pi, {
			id: "agent:Detail",
			kind: "agent",
			group: "𖠌 Agents",
			priority: 0,
			conflictSets: [],
			defaultActive: true,
			label: "Detail",
			description: "Has a settings detail.",
			summary: "settings",
			projectPrivate: false,
			owner: "test",
			detail: {
				render: () => ["Detail panel"],
				handleInput: () => true,
			},
		});
		const engineFor = (globalDisabled: readonly string[]): LoadoutEngine => ({
			start: async () => undefined,
			dispose: () => undefined,
			snapshot: () => ({
				configuration: {
					global: { disabled: [...globalDisabled], enabled: [] },
					project: { disabled: [], enabled: [] },
				},
				initialActiveToolNames: ["read"],
			}),
		});
		try {
			// Enabled: global scope, no delta, defaultActive true.
			const enabled = createLoadoutPage(h.pi, engineFor([]), h.context);
			await enabled.handleInput("\u001b[B");
			await enabled.handleInput("\u001b[B");
			const enabledView = enabled.component.render(100).join("\n");
			expect(enabledView).toContain("● Detail");
			expect(enabledView).toContain("Status: ● Active");
			// Disabled: a global delta disables the row.
			const disabled = createLoadoutPage(h.pi, engineFor(["agent:Detail"]), h.context);
			await disabled.handleInput("\u001b[B");
			await disabled.handleInput("\u001b[B");
			const disabledView = disabled.component.render(100).join("\n");
			expect(disabledView).toContain("○ Detail");
			expect(disabledView).toContain("Status: ○ Disabled");
			// Inherit: project scope, no project delta, global-visible row.
			const inherited = createLoadoutPage(h.pi, engineFor([]), h.context);
			await inherited.handleInput("\u001b[112;5u"); // ctrl+p → project
			await inherited.handleInput("\u001b[B");
			await inherited.handleInput("\u001b[B");
			const inheritedView = inherited.component.render(100).join("\n");
			expect(inheritedView).toContain("◌ Detail");
			expect(inheritedView).toContain("Status: ◌ Inherit");
		} finally {
			dispose();
		}
	});

	test("composes the real agent detail under the resource header without a duplicate title", async () => {
		const h = setup();
		const root = await mkdtemp(join(tmpdir(), "pi-loadout-agent-"));
		temporaryRoots.push(root);
		const agentsDir = join(root, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "Explore.md"),
			"---\ndescription: Read-only explorer.\n---\nYou are read-only.\n",
		);
		vi.spyOn(process, "cwd").mockReturnValue(root);
		const config: AgentConfig = {
			name: "Explore",
			description: "Read-only explorer.",
			extensions: true,
			skills: true,
			systemPrompt: "You are read-only.",
			promptMode: "replace",
			isDefault: true,
			source: "default",
		};
		const detail = createAgentDetail(
			"Explore",
			config,
			{
				getAvailable: () => [{ provider: "cx", id: "gpt-5.6-luna" }],
				hasConfiguredAuth: () => true,
			},
			() => undefined,
			() => undefined,
		);
		const themeSpy = vi.spyOn(detail, "onThemeChange");
		const dispose = registerLoadoutResource(h.pi, {
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
		try {
			const page = createLoadoutPage(h.pi, fakeEngine(), h.context);
			await page.handleInput("\u001b[B");
			await page.handleInput("\u001b[B");
			const before = page.component.render(100).join("\n");
			expect(before).toContain("Explore (agent)");
			expect(before).toContain("Origin: @hheei/pi-subagents");
			expect(before).toContain("Status: ● Active");
			await page.handleInput("\r");
			const openedLines = page.component.render(100);
			const opened = openedLines.join("\n");
			// Exact requested layout: title → wrapped Description → Origin →
			// Status → Path → detail rows. The hint row is the ordinary list
			// hint on the last panel row. Opening pushes the current theme so
			// accent styling is live from the first frame.
			expect(themeSpy).toHaveBeenCalled();
			expect(openedLines.at(-1)).toContain("↕ navigate");
			expect(opened.indexOf("Explore (agent)")).toBeLessThan(opened.indexOf("Origin:"));
			expect(opened.indexOf("Explore (agent)")).toBeLessThan(opened.indexOf("Read-only explorer."));
			expect(opened.indexOf("Read-only explorer.")).toBeLessThan(opened.indexOf("Origin:"));
			expect(opened.indexOf("Origin:")).toBeLessThan(opened.indexOf("Status:"));
			expect(opened.indexOf("Status:")).toBeLessThan(opened.indexOf("Path:"));
			expect(opened.indexOf("Path:")).toBeLessThan(opened.indexOf("Identity"));
			expect(opened).toMatch(/Identity\s+Explore/);
			expect(opened).toMatch(/Model\s+inherit/);
			expect(opened).toMatch(/Path:\s+\S/);
			expect(opened).not.toContain("Agent Explore");
			await page.handleInput("\u001b[B"); // Identity → Model
			await page.handleInput("\r"); // open selector
			await page.handleInput("\u001b[B"); // inherit → cx/gpt-5.6-luna
			await page.handleInput("\r"); // confirm buffered selection
			await page.handleInput("\u001b"); // return to resource list
			expect(page.component.render(100).join("\n")).toContain("cx/gpt-5.6-luna");
		} finally {
			dispose();
			vi.restoreAllMocks();
		}
	});

	test("truncates a long Path from the head, keeping the file name", async () => {
		const h = setup();
		const root = await mkdtemp(join(tmpdir(), "pi-loadout-path-"));
		temporaryRoots.push(root);
		const deep = join(
			root,
			"directory-one",
			"directory-two",
			"directory-three",
			"directory-four",
			"directory-five",
		);
		const agentsDir = join(deep, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "Explore.md"),
			"---\ndescription: Read-only explorer.\n---\nYou are read-only.\n",
		);
		vi.spyOn(process, "cwd").mockReturnValue(deep);
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
			{ getAvailable: () => [], hasConfiguredAuth: () => false },
			() => undefined,
			() => undefined,
		);
		const dispose = registerLoadoutResource(h.pi, {
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
		try {
			const page = createLoadoutPage(h.pi, fakeEngine(), h.context);
			await page.handleInput("\u001b[B");
			await page.handleInput("\u001b[B");
			await page.handleInput("\r");
			const opened = page.component.render(100).join("\n");
			// One leading ellipsis, then whole segments only: the five
			// directory-* segments do not fit the lane, so the longest complete
			// suffix is exactly …/.pi/agents/Explore.md — no mid-name slice.
			expect(opened).toContain("Path: …/.pi/agents/Explore.md");
			expect(opened).not.toContain("directory-");
		} finally {
			dispose();
			vi.restoreAllMocks();
		}
	});

	test("clamps the description to three lines only while the detail is open", async () => {
		const h = setup();
		const root = await mkdtemp(join(tmpdir(), "pi-loadout-desc-"));
		temporaryRoots.push(root);
		const agentsDir = join(root, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		const longDescription = [
			"Read-only explorer that inspects files, searches the workspace, and reports",
			"findings for planning and review. It never writes, edits, or executes",
			"destructive actions. It collects evidence, quotes sources, and hands off",
			"a compressed summary for the orchestrator.",
		].join(" ");
		writeFileSync(
			join(agentsDir, "Explore.md"),
			`---\ndescription: ${longDescription}\n---\nYou are read-only.\n`,
		);
		vi.spyOn(process, "cwd").mockReturnValue(root);
		const config: AgentConfig = {
			name: "Explore",
			description: longDescription,
			extensions: true,
			skills: true,
			systemPrompt: "You are read-only.",
			promptMode: "replace",
			source: "project",
		};
		const detail = createAgentDetail(
			"Explore",
			config,
			{ getAvailable: () => [], hasConfiguredAuth: () => false },
			() => undefined,
			() => undefined,
		);
		const dispose = registerLoadoutResource(h.pi, {
			id: "agent:Explore",
			kind: "agent",
			group: "𖠌 Agents",
			priority: 0,
			conflictSets: [],
			defaultActive: true,
			label: "Explore",
			description: longDescription,
			summary: "inherit",
			projectPrivate: false,
			owner: "@hheei/pi-subagents",
			detail,
		});
		const rowsBetweenTitleAndOrigin = (lines: readonly string[]): number => {
			const title = lines.findIndex((line) => line.includes("(agent)"));
			const origin = lines.findIndex((line) => line.includes("Origin:"));
			return origin - title - 1;
		};
		try {
			const page = createLoadoutPage(h.pi, fakeEngine(), h.context);
			await page.handleInput("\u001b[B");
			await page.handleInput("\u001b[B"); // select Explore, detail not open
			const before = page.component.render(100);
			// Browsing shows the full wrap (more than three lines).
			expect(rowsBetweenTitleAndOrigin(before)).toBeGreaterThan(4);
			await page.handleInput("\r"); // open the detail
			const after = page.component.render(100);
			// Editing clamps to three lines plus the separator blank.
			expect(rowsBetweenTitleAndOrigin(after)).toBe(4);
		} finally {
			dispose();
			vi.restoreAllMocks();
		}
	});

	test("flushes every edited agent detail once on close, including after returning to the list", async () => {
		const h = setup();
		const root = await mkdtemp(join(tmpdir(), "pi-loadout-flush-"));
		temporaryRoots.push(root);
		const agentsDir = join(root, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, "One.md"), "---\ndescription: One.\n---\nOne body.\n");
		writeFileSync(join(agentsDir, "Two.md"), "---\ndescription: Two.\n---\nTwo body.\n");
		vi.spyOn(process, "cwd").mockReturnValue(root);
		const registry = {
			getAvailable: () => [],
			hasConfiguredAuth: () => false,
		};
		const make = (name: string, description: string): AgentDetail =>
			createAgentDetail(
				name,
				{
					name,
					description,
					extensions: true,
					skills: true,
					systemPrompt: `${description} body.\n`,
					promptMode: "replace",
					source: "project",
				},
				registry,
				() => undefined,
				() => undefined,
			);
		const one = make("One", "One");
		const two = make("Two", "Two");
		const disposeOne = registerLoadoutResource(h.pi, {
			id: "agent:One",
			kind: "agent",
			group: "𖠌 Agents",
			priority: 0,
			conflictSets: [],
			defaultActive: true,
			label: "One",
			description: "One.",
			summary: "inherit",
			projectPrivate: false,
			owner: "test",
			detail: one,
		});
		const disposeTwo = registerLoadoutResource(h.pi, {
			id: "agent:Two",
			kind: "agent",
			group: "𖠌 Agents",
			priority: 0,
			conflictSets: [],
			defaultActive: true,
			label: "Two",
			description: "Two.",
			summary: "inherit",
			projectPrivate: false,
			owner: "test",
			detail: two,
		});
		try {
			const page = createLoadoutPage(h.pi, fakeEngine(), h.context);
			// Edit One, then return to the list…
			await page.handleInput("\u001b[B");
			await page.handleInput("\u001b[B"); // read → project_check → One
			await page.handleInput("\r"); // open One's detail
			await page.handleInput("x");
			await page.handleInput("\u001b"); // back to the list (no flush yet)
			// …and edit Two before closing.
			await page.handleInput("\u001b[B"); // One → Two
			await page.handleInput("\r"); // open Two's detail
			await page.handleInput("y");
			await page.handleInput("\u001b"); // back to the list
			await page.close();
			// Both edits land only on close, each in its own file.
			expect(readFile(join(agentsDir, "One.md"), "utf8")).resolves.toContain('display_name: "x"');
			expect(readFile(join(agentsDir, "Two.md"), "utf8")).resolves.toContain('display_name: "y"');
		} finally {
			disposeOne();
			disposeTwo();
			vi.restoreAllMocks();
		}
	});

	test("flushes one scope before switching and prints reload info only after surface close", async () => {
		const h = setup();
		const settings = await paths();
		const page = createLoadoutPage(h.pi, fakeEngine(), h.context, { paths: settings });
		await page.handleInput(" ");
		await page.handleInput("\u0010");
		expect(JSON.parse(await readFile(settings.globalPath, "utf8"))).toEqual({
			"pi-loadout": { disabled: ["tool:read"] },
		});
		expect(h.notifications).toEqual([]);
		await page.close();
		expect(h.notifications).toEqual([
			{ message: "※ Reload to apply Loadout changes.", type: "info" },
		]);
	});

	test("drops a net-zero draft without writing or announcing reload", async () => {
		const h = setup();
		const settings = await paths();
		const page = createLoadoutPage(h.pi, fakeEngine(), h.context, { paths: settings });
		await page.handleInput(" ");
		await page.handleInput(" ");
		await page.handleInput("\u001b");
		expect(h.closes.value).toBe(1);
		expect(h.notifications).toEqual([]);
		let missing = false;
		try {
			await readFile(settings.globalPath, "utf8");
		} catch {
			missing = true;
		}
		expect(missing).toBe(true);
	});
});
