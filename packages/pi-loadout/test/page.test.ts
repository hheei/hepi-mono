import { afterEach, describe, expect, test, vi } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	type ExtensionPageViewContext,
	type PiSettingsPaths,
	registerLoadoutResource,
	registerManagedLoadoutTool,
} from "@hheei/pi-ext-core";
import { replayTui, viewFrame } from "../../hepi-debug/src/tui-replay.js";
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
} {
	const notifications: Array<{ readonly message: string; readonly type: string | undefined }> = [];
	const closes = { value: 0 };
	const pi = {
		events: {},
		registerTool: () => undefined,
		getAllTools: () =>
			[
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
			] as ToolInfo[],
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
		requestClose: () => {
			closes.value++;
		},
	} as ExtensionPageViewContext;
	return { pi, context, notifications, closes };
}

describe("Loadout Settings page", () => {
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
			expect(page.component.render(100).join("\n")).toContain("↵ Edit config");
			await page.handleInput("\r");
			const opened = page.component.render(100).join("\n");
			expect(opened).toContain("Detail (agent)");
			expect(opened).toContain("Origin: test");
			expect(opened).toContain("Status: ● Active");
			expect(opened).toContain("Detail panel");
			expect(opened).toContain("↵ Edit config");
			await page.handleInput("x");
			expect(inputs).toEqual(["x"]);
			await page.handleInput("\u001b");
			expect(inputs).toEqual(["x", "\u001b"]);
			const back = page.component.render(100).join("\n");
			expect(back).toContain("↵ Edit config");
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
			source: "project",
		};
		const detail = createAgentDetail(
			h.pi,
			"Explore",
			config,
			{
				getAvailable: () => [{ provider: "cx", id: "gpt-5.6-luna" }],
				hasConfiguredAuth: () => true,
			},
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
			summary: "cx/gpt-5.6-luna",
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
			expect(page.component.render(100).at(-1)).toContain("↵ Edit config");
			await page.handleInput("\r");
			const openedLines = page.component.render(100);
			const opened = openedLines.join("\n");
			// The hint is pinned to the fixed panel's last row, not appended
			// directly after the detail rows.
			expect(openedLines.at(-1)).toContain("↵ Edit config");
			const descRow = openedLines.findIndex((line) => line.includes("Read-only explorer."));
			expect(descRow).toBeGreaterThanOrEqual(0);
			expect(descRow).toBeLessThan(openedLines.length - 1);
			// Exact requested layout: title → Origin → Status → detail rows →
			// trailing Enter hint. The description text only appears inside the
			// detail's Description row, not between the title and Origin.
			expect(opened.indexOf("Explore (agent)")).toBeLessThan(opened.indexOf("Origin:"));
			expect(opened.indexOf("Origin:")).toBeLessThan(opened.indexOf("Status:"));
			expect(opened.indexOf("Status:")).toBeLessThan(opened.indexOf("Path:"));
			expect(opened.indexOf("Path:")).toBeLessThan(opened.indexOf("Read-only explorer."));
			expect(opened.indexOf("Read-only explorer.")).toBeLessThan(opened.indexOf("↵ Edit config"));
			expect(opened).toMatch(/Identity\s+Explore/);
			expect(opened).toMatch(/Model\s+inherit/);
			expect(opened).toMatch(/Path:\s+\S/);
			expect(opened).not.toContain("Agent Explore");
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
				h.pi,
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
			page.close();
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
