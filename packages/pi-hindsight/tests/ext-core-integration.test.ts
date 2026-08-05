import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getHepiRuntimeSettingsRegistry,
	isManagedLoadoutTool,
	observeLoadoutInventory,
} from "@hheei/pi-ext-core";
import { describe, expect, it, vi } from "vitest";
import hindsightExtension from "../extensions/index.js";

type Handler = (event: unknown, context: unknown) => Promise<unknown> | unknown;

function createPi() {
	const handlers = new Map<string, Handler[]>();
	const tools: string[] = [];
	const commands: string[] = [];
	const pi = {
		events: {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (tool: { name: string }) => {
			tools.push(tool.name);
		},
		registerCommand: (name: string) => {
			commands.push(name);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, tools, commands };
}

describe("ext-core integration", () => {
	it("registers managed tools and lifecycle-owned settings", async () => {
		const { pi, handlers, tools, commands } = createPi();
		const inventory: string[][] = [];
		const observer = new AbortController();
		observeLoadoutInventory(pi, {
			signal: observer.signal,
			onChange: (items) => inventory.push(items.map((item) => item.id)),
		});

		hindsightExtension(pi);

		expect(commands).toEqual(["hindsight", "hindsight:next-opt-out"]);
		expect(tools).toContain("hindsight_recall");
		expect(tools).toContain("hindsight_scope_migrate");
		expect(isManagedLoadoutTool(pi, "hindsight_recall")).toBe(true);
		expect(inventory.at(-1)).toContain("hindsight_recall");

		const context = {
			cwd: process.cwd(),
			ui: { notify: vi.fn(), setStatus: vi.fn() },
			sessionManager: { getSessionFile: () => undefined, getSessionId: () => "test" },
		};
		const start = handlers.get("session_start")?.[0];
		const shutdown = handlers.get("session_shutdown")?.[0];
		if (!start || !shutdown) throw new Error("Missing lifecycle handlers");

		await start({}, context);
		expect(getHepiRuntimeSettingsRegistry(pi).get("pi-hindsight")).toBeDefined();

		await shutdown({}, context);
		expect(getHepiRuntimeSettingsRegistry(pi).get("pi-hindsight")).toBeUndefined();
		observer.abort();
	});
});
