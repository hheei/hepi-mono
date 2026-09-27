import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type ExtensionPageViewContext,
	type ExtensionSettingsPaths,
	type LoadoutResourceDetailContext,
	registerLoadoutResource,
} from "@hheei/pi-ext-core";
import { afterEach, describe, expect, test } from "vitest";
import { replayTui, viewFrame } from "../../../pi-debug/src/tui-replay.js";
import type { LoadoutEngine } from "../../src/loadout/engine.js";
import { createLoadoutPage } from "../../src/loadout/page.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function paths(): Promise<ExtensionSettingsPaths> {
	const root = await mkdtemp(join(tmpdir(), "pi-settings-loadout-page-"));
	temporaryRoots.push(root);
	return { globalPath: join(root, "agent.json"), projectPath: join(root, "project.json") };
}

function engineFor(globalDisabled: readonly string[] = []): LoadoutEngine {
	return {
		start: async () => undefined,
		reload: async () => undefined,
		dispose: () => undefined,
		snapshot: () => ({
			configuration: {
				global: { disabled: [...globalDisabled], enabled: [] },
				project: { disabled: [], enabled: [] },
			},
		}),
	};
}

interface ResourceOptions {
	readonly id: string;
	readonly label: string;
	readonly summary: string;
	readonly description?: string;
	readonly projectPrivate?: boolean;
	readonly detail?: {
		readonly render: (width: number) => readonly string[];
		readonly handleInput: (
			input: string,
			context: LoadoutResourceDetailContext,
		) => boolean | Promise<boolean>;
	};
}

function agentResource(options: ResourceOptions) {
	return {
		id: options.id,
		kind: "agent" as const,
		label: options.label,
		description: options.description ?? "Agent profile.",
		summary: options.summary,
		projectPrivate: options.projectPrivate ?? false,
		owner: "test-agent",
		defaultActive: true,
		...(options.detail === undefined ? {} : { detail: options.detail }),
	};
}

function setup(): {
	readonly pi: ExtensionAPI;
	readonly context: ExtensionPageViewContext;
	readonly notifications: Array<{ readonly message: string; readonly type: string | undefined }>;
	readonly closes: { value: number };
	readonly editors: Array<{ readonly title: string; readonly prefill: string | undefined }>;
} {
	const notifications: Array<{ readonly message: string; readonly type: string | undefined }> = [];
	const closes = { value: 0 };
	const editors: Array<{ readonly title: string; readonly prefill: string | undefined }> = [];
	const pi = {
		events: {},
		registerTool: () => undefined,
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
	return { pi, context, notifications, closes, editors };
}

describe("Loadout Settings page", () => {
	test("lists skills and resources only, with no tool rows or Tools group", async () => {
		const h = setup();
		const dispose = registerLoadoutResource(
			h.pi,
			agentResource({ id: "agent:Explore", label: "Explore", summary: "◔ cx/gpt-5.6-luna" }),
		);
		const page = createLoadoutPage(h.pi, engineFor(), h.context);
		const global = page.component.render(100).join("\n");
		expect(global).toContain("✦ Skills");
		expect(global).toContain("𖠌 Agents");
		expect(global).not.toContain("⚒ Tools");
		expect(global).toContain("review (skill)");
		expect(global).toContain("Review changed code.");
		expect(global).toContain("Origin: Pi skill");
		expect(global).toContain("Status: ● Active");
		expect(global).not.toContain("Effective:");
		expect(global).not.toContain("Policy:");
		expect(global).not.toContain("This scope:");
		expect(global).not.toContain("Default:");
		expect(global).not.toContain("read (tool)");
		expect(global).not.toContain("project_check");
		dispose();
	});

	test("keeps one selected-resource Description block inside the fixed panel height", async () => {
		const h = setup();
		const page = createLoadoutPage(h.pi, engineFor(), h.context);
		const global = page.component.render(100).join("\n");
		const replay = await replayTui({
			columns: 100,
			rows: 20,
			create: () => page.component,
			actions: [],
		});
		const frame = viewFrame(replay.last);
		expect(frame).toHaveLength(20);
		const replayRow = frame.find((line) => line.includes("Skill"));
		expect(replayRow).toBeDefined();
		expect(global).toContain("review (skill)");
	});

	test("renders registered agents after skills with activation and model summary", () => {
		const h = setup();
		const dispose = registerLoadoutResource(
			h.pi,
			agentResource({ id: "agent:Explore", label: "Explore", summary: "◔ cx/gpt-5.6-luna" }),
		);
		const page = createLoadoutPage(h.pi, engineFor(), h.context);
		const output = page.component.render(100).join("\n");
		expect(output).toContain("✦ Skills");
		expect(output).toContain("𖠌 Agents");
		expect(output).toContain("● Explore");
		expect(output).toContain("◔ cx/gpt-5.6-luna");
		expect(output.indexOf("✦ Skills")).toBeLessThan(output.indexOf("𖠌 Agents"));
		// No detail contribution → no Edit config affordance in the Description lane.
		expect(output).not.toContain("↵ Edit config");
		dispose();
	});

	test("hides project-private resources while the global scope is selected", async () => {
		const h = setup();
		const dispose = registerLoadoutResource(
			h.pi,
			agentResource({
				id: "agent:Local",
				label: "Local",
				summary: "project only",
				projectPrivate: true,
			}),
		);
		const page = createLoadoutPage(h.pi, engineFor(), h.context);
		expect(page.component.render(100).join("\n")).not.toContain("Local");
		await page.handleInput("\u001b[112;5u"); // ctrl+p → project
		const project = page.component.render(100).join("\n");
		expect(project).toContain("Project · /workspace/.pi/ext_settings.json");
		expect(project).toContain("Local");
		dispose();
	});

	test("enters registered resource detail, routes input, and exits with Escape", async () => {
		const h = setup();
		const inputs: string[] = [];
		const dispose = registerLoadoutResource(
			h.pi,
			agentResource({
				id: "agent:Detail",
				label: "Detail",
				summary: "settings",
				description: "Has a settings detail.",
				detail: {
					render: (width) => [`Detail panel ${width}`],
					handleInput: (input) => {
						inputs.push(input);
						return input !== "\u001b"; // decline Esc so the page backs out
					},
				},
			}),
		);
		try {
			const page = createLoadoutPage(h.pi, engineFor(), h.context);
			expect(page.component.render(100).join("\n")).toContain("↵");
			await page.handleInput("\u001b[B");
			await page.handleInput("\r");
			const opened = page.component.render(100).join("\n");
			expect(opened).toContain("Detail (agent)");
			expect(opened).toContain("Origin: test-agent");
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
		const dispose = registerLoadoutResource(
			h.pi,
			agentResource({
				id: "agent:Detail",
				label: "Detail",
				summary: "settings",
				detail: { render: () => ["Detail panel"], handleInput: () => true },
			}),
		);
		try {
			const page = createLoadoutPage(h.pi, engineFor(), h.context);
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
		const disposeDetail = registerLoadoutResource(
			h.pi,
			agentResource({
				id: "agent:Detail",
				label: "Detail",
				summary: "settings",
				detail: {
					render: () => ["Detail panel"],
					handleInput: (input) => {
						inputs.push(input);
						return input !== "\u001b";
					},
				},
			}),
		);
		const disposeZulu = registerLoadoutResource(
			h.pi,
			agentResource({ id: "agent:Zulu", label: "Zulu", summary: "second resource" }),
		);
		try {
			const page = createLoadoutPage(h.pi, engineFor(), h.context);
			// Rows sort as: review, Zulu, Detail — select the detail row.
			await page.handleInput("\u001b[B");
			await page.handleInput("\u001b[B");
			await page.handleInput("\r");
			expect(page.component.render(100).join("\n")).toContain("Detail panel");
			await page.handleInput("\x1b[<64;1;1M"); // SGR wheel up
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
		const dispose = registerLoadoutResource(
			h.pi,
			agentResource({
				id: "agent:Editor",
				label: "Editor",
				summary: "settings",
				detail: {
					render: () => ["Detail panel"],
					handleInput: async (input, context) => {
						inputs.push(input);
						contexts.push(context);
						if (input === "e") await context.openEditor("Body", "draft body");
						return input !== "\u001b";
					},
				},
			}),
		);
		try {
			const page = createLoadoutPage(h.pi, engineFor(), h.context);
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
		const dispose = registerLoadoutResource(
			h.pi,
			agentResource({
				id: "agent:Detail",
				label: "Detail",
				summary: "settings",
				detail: {
					render: () => ["Detail panel"],
					handleInput: (input) => {
						inputs.push(input);
						return true;
					},
				},
			}),
		);
		try {
			// Disabled: a global delta disables the row, so the hint is gone and
			// Enter must not open the detail.
			const disabled = createLoadoutPage(h.pi, engineFor(["agent:Detail"]), h.context);
			await disabled.handleInput("\u001b[B");
			expect(disabled.component.render(100).join("\n")).not.toContain("↵");
			await disabled.handleInput("\r");
			expect(disabled.component.render(100).join("\n")).not.toContain("Detail panel");
			// Inherited: project scope with no project-private row and no delta.
			const inherited = createLoadoutPage(h.pi, engineFor(), h.context);
			await inherited.handleInput("\u001b[112;5u"); // ctrl+p → project
			await inherited.handleInput("\u001b[B");
			const project = inherited.component.render(100).join("\n");
			expect(project).toContain("Project · /workspace/.pi/ext_settings.json");
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
		const dispose = registerLoadoutResource(
			h.pi,
			agentResource({
				id: "agent:Detail",
				label: "Detail",
				summary: "settings",
				detail: { render: () => ["Detail panel"], handleInput: () => true },
			}),
		);
		try {
			// Enabled: global scope, no delta, defaultActive true.
			const enabled = createLoadoutPage(h.pi, engineFor(), h.context);
			await enabled.handleInput("\u001b[B");
			const enabledView = enabled.component.render(100).join("\n");
			expect(enabledView).toContain("● Detail");
			expect(enabledView).toContain("Status: ● Active");
			// Disabled: a global delta disables the row.
			const disabled = createLoadoutPage(h.pi, engineFor(["agent:Detail"]), h.context);
			await disabled.handleInput("\u001b[B");
			const disabledView = disabled.component.render(100).join("\n");
			expect(disabledView).toContain("○ Detail");
			expect(disabledView).toContain("Status: ○ Disabled");
			// Inherit: project scope, no project delta, global-visible row.
			const inherited = createLoadoutPage(h.pi, engineFor(), h.context);
			await inherited.handleInput("\u001b[112;5u"); // ctrl+p → project
			await inherited.handleInput("\u001b[B");
			const inheritedView = inherited.component.render(100).join("\n");
			expect(inheritedView).toContain("◌ Detail");
			expect(inheritedView).toContain("Status: ◌ Inherit");
		} finally {
			dispose();
		}
	});

	test("persists one scope on switch, applies it through the engine, and sends no reload notice", async () => {
		const h = setup();
		const settings = await paths();
		let reloads = 0;
		const engine: LoadoutEngine = {
			...engineFor(),
			reload: async () => {
				reloads++;
			},
		};
		const page = createLoadoutPage(h.pi, engine, h.context, { paths: settings });
		await page.handleInput(" ");
		await page.handleInput("\u0010");
		expect(JSON.parse(await readFile(settings.globalPath, "utf8"))).toEqual({
			loadout: { disabled: ["skill:review"] },
		});
		expect(reloads).toBe(1);
		expect(h.notifications).toEqual([]);
		await page.close();
		expect(h.notifications).toEqual([]);
	});

	test("drops a net-zero draft without writing or applying anything", async () => {
		const h = setup();
		const settings = await paths();
		let reloads = 0;
		const engine: LoadoutEngine = {
			...engineFor(),
			reload: async () => {
				reloads++;
			},
		};
		const page = createLoadoutPage(h.pi, engine, h.context, { paths: settings });
		await page.handleInput(" ");
		await page.handleInput(" ");
		await page.handleInput("\u001b");
		expect(h.closes.value).toBe(1);
		expect(reloads).toBe(0);
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
