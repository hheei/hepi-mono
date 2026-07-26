import { describe, expect, test } from "bun:test";
import type { LoadoutItem } from "../../../src/loadout/model.js";
import { createLoadoutDescriptionRegistry } from "../../../src/loadout/model.js";
import { renderLoadout } from "../../../src/loadout/render.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const item: LoadoutItem = {
	key: "tool:plugin:inspect",
	name: "inspect",
	kind: "tool",
	sourceScope: "global",
	hasGlobalDefinition: true,
	origin: "plugin",
};

const state = {
	scope: "global" as const,
	view: "tools" as const,
	query: "",
	inventory: [item],
	resolved: [
		{
			...item,
			configuredStatus: "active" as const,
			effectiveStatus: "active" as const,
			displayStatus: "active" as const,
		},
	],
	selectedKey: item.key,
};

describe("loadout description panels", () => {
	test("supports isolated registries and stable kind/name lookup", () => {
		const registry = createLoadoutDescriptionRegistry();
		registry.register("tool:inspect", { title: "Inspect tool", lines: ["Registered details"] });
		expect(registry.get(item)?.title).toBe("Inspect tool");
		expect(registry.get(item)?.lines).toEqual(["Registered details"]);
	});

	test("renders content from an injected registry without auto-generated sections", () => {
		const registry = createLoadoutDescriptionRegistry();
		registry.register("tool:inspect", {
			title: "Inspect tool",
			lines: ["Registered details"],
		});
		const registeredItem = { ...item, descriptionPanel: registry.get(item) };
		const output = renderLoadout({
			state: {
				...state,
				inventory: [registeredItem],
				resolved: [{ ...state.resolved[0]!, ...registeredItem }],
			},
			theme,
			width: 100,
			height: 20,
		}).join("\\n");
		expect(output).toContain("Inspect tool");
		expect(output).toContain("Registered details");
		expect(output).not.toContain("Description: unavailable");
	});

	test("shows an explicit fallback when metadata is unavailable", () => {
		const output = renderLoadout({ state, theme, width: 100, height: 20 }).join("\n");
		expect(output).not.toContain("Description: unavailable");
		expect(output).not.toContain("Instruction: unavailable");
	});
});
