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

function surface(actions: FleetAction[] = [], records: readonly AgentRecord[] = []): FleetSurface {
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
		listDefinitions: () => ["reviewer"],
		getDefinition: (name) => (name === "reviewer" ? config : undefined),
		getModelLabel: () => "inherit",
		scheduleCount: () => 2,
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
});
