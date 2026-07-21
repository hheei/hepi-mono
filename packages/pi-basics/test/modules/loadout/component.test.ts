import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createLoadoutView } from "../../../src/modules/loadout/component.js";
import { createLoadoutController } from "../../../src/modules/loadout/controller.js";
import type { LoadoutItem } from "../../../src/modules/loadout/model.js";

const theme: Pick<Theme, "fg" | "bold"> = {
	fg: (_color, text) => text,
	bold: (text) => text,
};
const item = (key: `tool:${string}`, description: string): LoadoutItem => ({
	key,
	name: key.slice(5),
	kind: "tool",
	sourceScope: "global",
	hasGlobalDefinition: true,
	origin: "test",
	description,
});

async function setup() {
	const controller = createLoadoutController({
		storage: { load: async () => ({ global: {}, project: {} }), update: async () => undefined },
		inventory: { load: async () => [item("tool:alpha", "first"), item("tool:beta", "second")] },
	});
	await controller.load();
	const host = {
		renders: 0,
		requestRender() {
			this.renders++;
		},
	};
	const component = createLoadoutView({ controller, theme, host });
	return { controller, component, host };
}

describe("loadout component", () => {
	test("delegates scope toggle and search to controller", async () => {
		const { controller, component } = await setup();
		component.handleInput?.("\t");
		expect(controller.state.scope).toBe("project");
		component.handleInput?.("b");
		expect(controller.state.query).toBe("b");
		const output = component.render(80).join("\n");
		expect(output).toContain("beta");
		expect(output).not.toContain("alpha");
		await controller.close();
	});

	test("toggles selected item with Space and preserves selection", async () => {
		const { component, controller, host } = await setup();
		const selectedKey = controller.state.selectedKey;
		const before = controller.state.resolved[0]?.configuredStatus;
		component.handleInput?.(" ");
		expect(controller.state.selectedKey).toBe(selectedKey);
		expect(controller.state.resolved[0]?.configuredStatus).not.toBe(before);
		expect(host.renders).toBeGreaterThan(0);
		await controller.close();
	});

	test("does not toggle selected item with Enter", async () => {
		const { component, controller, host } = await setup();
		const selectedKey = controller.state.selectedKey;
		const before = controller.state.resolved[0]?.configuredStatus;
		component.handleInput?.("\r");
		expect(controller.state.selectedKey).toBe(selectedKey);
		expect(controller.state.resolved[0]?.configuredStatus).toBe(before);
		expect(host.renders).toBe(0);
		await controller.close();
	});

	test("renders selected status through grouped renderer", async () => {
		const { component, controller } = await setup();
		const output = component.render(40).join("\n");
		expect(output).toContain("Tools (2)");
		expect(output).toContain("→ ● alpha");
		await controller.close();
	});
});
