import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@hheei/pi-basics";
import type { LoadoutItem, LoadoutResolvedItem } from "../../../src/model.js";
import { type LoadoutRenderSnapshot, renderLoadout } from "../../../src/render.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const item = (
	kind: LoadoutItem["kind"],
	name: string,
	extra: Partial<LoadoutItem> = {},
): LoadoutItem => ({
	key: `${kind}:${name}` as `${LoadoutItem["kind"]}:${string}`,
	name,
	kind,
	sourceScope: "global",
	hasGlobalDefinition: true,
	origin: "built-in",
	...extra,
});

const snapshot = (
	items: readonly LoadoutResolvedItem[],
	extra: Partial<LoadoutRenderSnapshot> = {},
): LoadoutRenderSnapshot => ({
	scope: "project",
	query: "",
	inventory: items,
	resolved: items,
	selectedKey: items[0]?.key,
	...extra,
});

describe("loadout renderer", () => {
	test("filters before grouping and shows filtered/total counts", () => {
		const all = [
			{
				...item("mcp", "server"),
				configuredStatus: "active",
				effectiveStatus: "active",
				displayStatus: "active",
			},
			{
				...item("tool", "build", { description: "compile project" }),
				configuredStatus: "active",
				effectiveStatus: "active",
				displayStatus: "active",
			},
			{
				...item("tool", "test"),
				configuredStatus: "disabled",
				effectiveStatus: "disabled",
				displayStatus: "disabled",
			},
		] as LoadoutResolvedItem[];
		const lines = renderLoadout({ state: snapshot(all, { query: "compile" }), theme, width: 60 });
		const output = lines.join("\n");
		expect(output).toContain("Tools (1/2)");
		expect(output).toContain("build");
		expect(output).not.toContain("MCP Servers");
		expect(output).not.toContain("test");
	});

	test("renders group order, status symbols, selection, and disabled inherited status", () => {
		const all = [
			{
				...item("skill", "skill"),
				configuredStatus: "inherit",
				effectiveStatus: "disabled",
				displayStatus: "disabled",
			},
			{
				...item("tool", "tool"),
				configuredStatus: "inherit",
				effectiveStatus: "active",
				displayStatus: "inherit",
			},
			{
				...item("mcp", "server"),
				configuredStatus: "active",
				effectiveStatus: "active",
				displayStatus: "active",
			},
		] as LoadoutResolvedItem[];
		const output = renderLoadout({
			state: snapshot(all, { selectedKey: "tool:tool" }),
			theme,
			width: 40,
		}).join("\n");
		expect(output.indexOf("MCP Servers")).toBeLessThan(output.indexOf("Tools"));
		expect(output.indexOf("Tools")).toBeLessThan(output.indexOf("Skills"));
		expect(output).toContain("● server");
		expect(output).toContain("◎ tool");
		expect(output).toContain("→ ◎ tool");
		expect(output).toContain("○ skill");
	});

	test("shows fixed wide description and hides it in narrow mode", () => {
		const all = [
			{
				...item("tool", "describe", {
					tokenCount: 123,
					origin: "plugin",
					description: "A long description",
					instruction: "Use this tool carefully.",
				}),
				configuredStatus: "active",
				effectiveStatus: "active",
				displayStatus: "active",
			},
		] as LoadoutResolvedItem[];
		const wideLines = renderLoadout({ state: snapshot(all), theme, width: 110 });
		const narrowLines = renderLoadout({ state: snapshot(all), theme, width: 40 });
		const wide = wideLines.join("\n");
		expect(wideLines[0]).toContain("Project · .pi/setting.json");
		expect(wideLines[1]).toContain("╭─ Description");
		expect(wide).toContain("Description");
		expect(wide).toContain("describe (tool) · 123 tokens");
		expect(wide).toContain("Origin: plugin");
		expect(wide).toContain("Instruction:");
		expect(narrowLines.join("\n")).not.toContain("Description");
	});

	test("renders error/footer and clamps every line", () => {
		const all = [
			{
				...item("tool", "very-long-name"),
				configuredStatus: "disabled",
				effectiveStatus: "disabled",
				displayStatus: "disabled",
			},
		] as LoadoutResolvedItem[];
		for (let width = 1; width <= 110; width++) {
			const lines = renderLoadout({
				state: snapshot(all, { error: "something failed" }),
				theme,
				width,
				path: "/project/.pi/setting.json",
			});
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		const output = renderLoadout({
			state: snapshot(all, { error: "something failed" }),
			theme,
			width: 80,
			path: "/project/.pi/setting.json",
		}).join("\n");
		expect(output).toContain("Project · /project/.pi/setting.json");
		expect(output).toContain("Error: something failed");
		expect(output).toContain("⇥ global");
	});
	test("caps body height at thirty percent of terminal rows", () => {
		const all = Array.from({ length: 10 }, (_, index) => ({
			...item("tool", `tool-${index}`),
			configuredStatus: "active" as const,
			effectiveStatus: "active" as const,
			displayStatus: "active" as const,
		}));
		const lines = renderLoadout({ state: snapshot(all), theme, width: 40, height: 10 });
		const footerIndex = lines.findIndex((line) => line.includes("↕"));
		expect(footerIndex).toBeGreaterThanOrEqual(0);
		expect(footerIndex - 4).toBeLessThanOrEqual(3);
	});
	test("starts scrollbar at first group row, not search padding", () => {
		const all = Array.from({ length: 20 }, (_, index) => ({
			...item("tool", `tool-${index}`),
			configuredStatus: "active" as const,
			effectiveStatus: "active" as const,
			displayStatus: "active" as const,
		}));
		const lines = renderLoadout({ state: snapshot(all), theme, width: 100, height: 30 });
		expect(lines.find((line) => line.includes("> _"))).not.toContain("█");
		const toolsLine = lines.find((line) => line.includes("⚒ Tools"));
		expect(toolsLine).toContain("█");
	});
});
