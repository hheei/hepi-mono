import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ExtensionPageViewContext, PiSettingsPaths } from "@hheei/pi-ext-core";
import { replayTui, viewFrame } from "../../hepi-debug/src/tui-replay.js";
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
		expect(global).toContain("Origin: Built-in");
		expect(global).toContain("Status: ● active");
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
