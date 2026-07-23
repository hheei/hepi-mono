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
		const item = tool("tool:extension:bash", { name: "bash" });
		let maps: LoadoutStatusMaps = { global: { "tool:bash": false }, project: {} };
		expect(nextConfiguredStatus(item, "project", maps)).toBe("active");
		maps = toggleLoadoutState(item, "project", maps);
		expect(maps.project["tool:bash"]).toBe(true);
		expect(nextConfiguredStatus(item, "project", maps)).toBe("disabled");
		maps = toggleLoadoutState(item, "project", maps);
		expect(maps.project["tool:bash"]).toBe(false);
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

	test("inherits an explicit global setting for a project-scoped tool", () => {
		const item = tool("tool:package:agent", {
			name: "agent",
			sourceScope: "project",
			hasGlobalDefinition: false,
		});
		let maps: LoadoutStatusMaps = { global: { "tool:agent": true }, project: {} };
		expect(resolveLoadoutItem(item, "project", maps)).toMatchObject({
			configuredStatus: "inherit",
			effectiveStatus: "active",
			displayStatus: "inherit",
		});

		maps = { ...maps, project: { "tool:agent": true } };
		expect(resolveLoadoutItem(item, "project", maps).configuredStatus).toBe("active");
		maps = toggleLoadoutState(item, "project", maps);
		expect(maps.project["tool:agent"]).toBe(false);
		maps = toggleLoadoutState(item, "project", maps);
		expect(Object.hasOwn(maps.project, "tool:agent")).toBe(false);
		expect(resolveLoadoutItem(item, "project", maps).configuredStatus).toBe("inherit");
	});

	test("project-only item has binary transitions", () => {
		const item = projectOnly("skill:local");
		let maps: LoadoutStatusMaps = { global: {}, project: {} };
		expect(nextConfiguredStatus(item, "project", maps)).toBe("disabled");
		maps = toggleLoadoutState(item, "project", maps);
		expect(maps.project["skill:local"]).toBe(false);
		expect(nextConfiguredStatus(item, "project", maps)).toBe("active");
		maps = toggleLoadoutState(item, "project", maps);
		expect(maps.project["skill:local"]).toBe(true);
	});

	test("global-capable project toggle writes stable key and preserves legacy reads", () => {
		const item = tool("tool:/old/path:read", { name: "read" });
		let maps: LoadoutStatusMaps = { global: {}, project: {} };
		maps = toggleLoadoutState(item, "project", maps);
		expect(maps.project["tool:read"]).toBe(true);
		maps = toggleLoadoutState(item, "project", maps);
		expect(maps.project["tool:read"]).toBe(false);
		maps = toggleLoadoutState(item, "project", maps);
		expect(Object.hasOwn(maps.project, "tool:read")).toBe(false);
		expect(
			resolveLoadoutItem({ ...item, key: "tool:/new/path:read" }, "global", {
				global: { "tool:/old/path:read": false },
				project: {},
			}).effectiveStatus,
		).toBe("disabled");
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

	test("filters searchable metadata and orders items by built-in then package", () => {
		const items = [
			{ ...tool("tool:zeta"), origin: "package-z" },
			{ ...tool("tool:aardvark"), origin: "package-b" },
			{ ...tool("tool:zulu"), origin: "package-a" },
			{ ...tool("tool:beta"), origin: "package-a" },
			{ ...tool("tool:bash"), origin: "builtin" },
			{ ...projectOnly("skill:docs"), description: "Documentation" },
			{ ...tool("tool:alpha"), description: "Filesystem", origin: "core" },
		];
		expect(sortLoadoutItems(items).map((item) => item.key)).toEqual([
			"tool:alpha",
			"tool:bash",
			"tool:beta",
			"tool:zulu",
			"tool:aardvark",
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
