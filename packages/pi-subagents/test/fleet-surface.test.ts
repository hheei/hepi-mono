import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentConfig, AgentRecord } from "../src/types.js";
import { type FleetAction, FleetSurface } from "../src/ui/fleet-surface.js";

const config: AgentConfig = {
	name: "reviewer",
	description: "Review changes for correctness and regressions.",
	extensions: true,
	skills: true,
	systemPrompt: "Review carefully.",
	promptMode: "replace",
	source: "project",
};

function theme(): Theme {
	return {
		fg: (_token: string, value: string) => value,
		bold: (value: string) => value,
	} as unknown as Theme;
}

function surface(
	actions: FleetAction[] = [],
	records: readonly AgentRecord[] = [],
	definitions: readonly string[] = ["reviewer"],
): FleetSurface {
	const tui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 120 } } as unknown as TUI;
	const manager = {
		listAgents: () => records,
		abort: vi.fn(() => true),
		steer: vi.fn(() => true),
	} as unknown as AgentManager;
	return new FleetSurface({
		tui,
		theme: theme(),
		manager,
		activity: new Map(),
		listDefinitions: () => definitions,
		getDefinition: (name) => (definitions.includes(name) ? { ...config, name } : undefined),
		getModelLabel: () => "inherit",
		scheduleCount: () => 2,
		scheduleDeferred: () => true,
		onAction: (action) => actions.push(action),
	});
}

function assertFits(lines: readonly string[], width: number): void {
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

describe("FleetSurface", () => {
	it("renders fixed-width wide and narrow Fleet layouts", () => {
		const fleet = surface();
		const wide = fleet.render(120);
		expect(wide).toHaveLength(20);
		expect(wide.join("\n")).toContain("Agent definitions");
		assertFits(wide, 120);

		const narrow = fleet.render(72);
		expect(narrow.length).toBeLessThanOrEqual(20);
		expect(narrow.join("\n")).toContain("reviewer");
		assertFits(narrow, 72);
	});

	it("returns definition actions instead of opening nested dialogs", () => {
		const actions: FleetAction[] = [];
		const fleet = surface(actions);
		fleet.handleInput("c");
		fleet.handleInput("g");
		fleet.handleInput("e");
		expect(actions).toEqual([
			{ kind: "create-manual" },
			{ kind: "create-generated" },
			{ kind: "edit", name: "reviewer" },
		]);
	});

	it("keeps the selected entry in the fixed list window", () => {
		const definitions = Array.from({ length: 14 }, (_, index) => `agent-${index}`);
		const fleet = surface([], [], definitions);
		for (let index = 0; index < definitions.length; index++) fleet.handleInput("\x1b[B");
		const wide = fleet.render(120).join("\n");
		expect(wide).toContain("agent-13");
		expect(wide).toContain("scroll");
		assertFits(wide.split("\n"), 120);

		const narrow = fleet.render(72).join("\n");
		expect(narrow).toContain("agent-13");
		expect(narrow).toContain("scroll");
		assertFits(narrow.split("\n"), 72);
	});

	it("shows retained terminal records and deferred schedules", () => {
		const terminal = {
			id: "completed-1",
			type: "reviewer",
			description: "retained terminal child",
			status: "completed",
			toolUses: 1,
			startedAt: 1,
			completedAt: 2,
			lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compactionCount: 0,
		} as unknown as AgentRecord;
		const fleet = surface([], [terminal]);
		const output = fleet.render(120).join("\n");
		expect(output).toContain("retained terminal child");
		expect(output).toContain("deferred");
	});
});
