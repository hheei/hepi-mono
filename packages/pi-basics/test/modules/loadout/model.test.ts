import { describe, expect, test } from "bun:test";
import {
	filterLoadoutItems,
	groupLoadoutItems,
	type LoadoutItem,
	type LoadoutStatusMaps,
	nextConfiguredStatus,
	reconcileLoadoutSelection,
	resolveLoadoutItem,
	resolveLoadoutItems,
	sortLoadoutItems,
	toggleLoadoutState,
} from "../../../src/modules/loadout/model.js";

const tool = (key: `tool:${string}`, extra: Partial<LoadoutItem> = {}): LoadoutItem => ({
	key,
	name: key.slice(5),
	kind: "tool",
	sourceScope: "global",
	hasGlobalDefinition: true,
	origin: "Pi",
	...extra,
});
const projectOnly = (key: `skill:${string}`): LoadoutItem => ({
	key,
	name: key.slice(6),
	kind: "skill",
	sourceScope: "project",
	hasGlobalDefinition: false,
	origin: "project",
});

describe("loadout model", () => {
	test("resolves global disabled plus project inherit as disabled display", () => {
		const item = tool("tool:read");
		const resolved = resolveLoadoutItem(item, "project", {
			global: { [item.key]: false },
			project: {},
		});
		expect(resolved.configuredStatus).toBe("inherit");
		expect(resolved.effectiveStatus).toBe("disabled");
		expect(resolved.displayStatus).toBe("disabled");
	});

	test("project uses binary transitions while global item is disabled", () => {
		const item = tool("tool:bash");
		let maps: LoadoutStatusMaps = { global: { [item.key]: false }, project: {} };
		expect(nextConfiguredStatus(item, "project", maps)).toBe("active");
		maps = toggleLoadoutState(item, "project", maps);
		expect(maps.project[item.key]).toBe(true);
		expect(nextConfiguredStatus(item, "project", maps)).toBe("disabled");
		maps = toggleLoadoutState(item, "project", maps);
		expect(maps.project[item.key]).toBe(false);
		expect(nextConfiguredStatus(item, "project", maps)).toBe("active");
	});

	test("preserves explicit project overrides", () => {
		const item = tool("tool:read");
		const maps: LoadoutStatusMaps = {
			global: { [item.key]: false },
			project: { [item.key]: true },
		};
		expect(resolveLoadoutItem(item, "project", maps)).toMatchObject({
			configuredStatus: "active",
			effectiveStatus: "active",
			displayStatus: "active",
		});
	});

	test("project-only item has binary transitions", () => {
		const item = projectOnly("skill:local");
		let maps: LoadoutStatusMaps = { global: {}, project: {} };
		expect(nextConfiguredStatus(item, "project", maps)).toBe("disabled");
		maps = toggleLoadoutState(item, "project", maps);
		expect(maps.project[item.key]).toBe(false);
		expect(nextConfiguredStatus(item, "project", maps)).toBe("active");
		maps = toggleLoadoutState(item, "project", maps);
		expect(maps.project[item.key]).toBe(true);
	});

	test("global-capable project toggle writes true, false, then deletes key", () => {
		const item = tool("tool:read");
		let maps: LoadoutStatusMaps = { global: {}, project: {} };
		maps = toggleLoadoutState(item, "project", maps);
		expect(maps.project[item.key]).toBe(true);
		maps = toggleLoadoutState(item, "project", maps);
		expect(maps.project[item.key]).toBe(false);
		maps = toggleLoadoutState(item, "project", maps);
		expect(Object.hasOwn(maps.project, item.key)).toBe(false);
	});
	test("locks lower-priority same-name tools behind selected winner", () => {
		const builtin = {
			...tool("tool:bash", { origin: "builtin", conflictGroup: "tool:bash" }),
		};
		const plugin = {
			...tool("tool:bash:plugin", { name: "bash", origin: "plugin", conflictGroup: "tool:bash" }),
		};
		const resolved = resolveLoadoutItems([plugin, builtin], "global", { global: {}, project: {} });
		expect(resolved.find((item) => item.origin === "builtin")?.lockedBy).toBeUndefined();
		expect(resolved.find((item) => item.origin === "plugin")).toMatchObject({
			displayStatus: "disabled",
			lockedBy: "tool:bash",
		});
	});

	test("filters searchable metadata and orders groups/items by built-in source", () => {
		const items = [
			{ ...tool("tool:zeta"), origin: "plugin" },
			{ ...tool("tool:bash"), origin: "builtin" },
			{ ...projectOnly("skill:docs"), description: "Documentation" },
			{ ...tool("tool:alpha"), description: "Filesystem", origin: "builtin" },
		];
		expect(sortLoadoutItems(items).map((item) => item.key)).toEqual([
			"tool:alpha",
			"tool:bash",
			"tool:zeta",
			"skill:docs",
		]);
		expect(filterLoadoutItems(items, "document").map((item) => item.key)).toEqual(["skill:docs"]);
		expect(groupLoadoutItems(items).map((group) => group.kind)).toEqual(["tool", "skill"]);
	});

	test("reconciles selection by identity, then group successor, then first visible", () => {
		const all = [tool("tool:a"), tool("tool:b"), tool("tool:c"), projectOnly("skill:x")];
		expect(reconcileLoadoutSelection(all, "tool:b")).toBe("tool:b");
		expect(
			reconcileLoadoutSelection(
				all.filter((item) => item.key !== "tool:b"),
				"tool:b",
				all,
			),
		).toBe("tool:c");
		expect(reconcileLoadoutSelection([projectOnly("skill:x")], "tool:b", all)).toBe("skill:x");
		expect(reconcileLoadoutSelection([], "tool:b")).toBeUndefined();
	});
});
