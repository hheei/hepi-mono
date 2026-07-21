import { describe, expect, test } from "bun:test";
import { createLoadoutController } from "../../../src/modules/loadout/controller.js";
import type { LoadoutItem } from "../../../src/modules/loadout/model.js";
import type { LoadoutStorage } from "../../../src/modules/loadout/storage.js";

const tool = (key: `tool:${string}`): LoadoutItem => ({
	key,
	name: key.slice(5),
	kind: "tool",
	sourceScope: "global",
	hasGlobalDefinition: true,
	origin: "test",
});
function storage(
	initial: Record<string, boolean> = {},
	update: LoadoutStorage["update"] = async () => {},
): LoadoutStorage {
	return { load: async () => ({ global: initial, project: {} }), update };
}
const inventory = (...items: LoadoutItem[]) => ({ load: async () => items });

describe("loadout controller", () => {
	test("loads concurrently and selects first item", async () => {
		const controller = createLoadoutController({
			storage: storage(),
			inventory: inventory(tool("tool:z"), tool("tool:a")),
		});
		await controller.load();
		expect(controller.state.selectedKey).toBe("tool:a");
		expect(controller.state.resolved.map((item) => item.key)).toEqual(["tool:a", "tool:z"]);
	});
	test("storage failure rolls optimistic model back without runtime apply", async () => {
		let applied = 0;
		const controller = createLoadoutController({
			storage: storage({}, async () => {
				throw new Error("disk failed");
			}),
			inventory: inventory(tool("tool:a")),
			runtime: {
				tool: async () => {
					applied++;
				},
			},
		});
		await controller.load();
		await controller.toggleSelected();
		expect(controller.state.resolved[0]?.effectiveStatus).toBe("active");
		expect(applied).toBe(1);
		expect(controller.state.error).toBe("disk failed");
	});
	test("runtime failure rolls disk and model back", async () => {
		const writes: unknown[] = [];
		const controller = createLoadoutController({
			storage: storage({}, async (_scope, _key, value) => {
				writes.push(value);
			}),
			inventory: inventory(tool("tool:a")),
			runtime: {
				tool: async (items) => {
					if (items[0]?.effectiveStatus === "disabled") throw new Error("runtime failed");
				},
			},
		});
		await controller.load();
		await controller.toggleSelected();
		expect(writes).toEqual([false, undefined]);
		expect(controller.state.resolved[0]?.effectiveStatus).toBe("active");
		expect(controller.state.error).toBe("runtime failed");
	});
	test("ignores duplicate pending toggle and reconciles selection on refresh", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let updates = 0;
		const controller = createLoadoutController({
			storage: storage({}, async () => {
				updates++;
				await gate;
			}),
			inventory: inventory(tool("tool:a"), tool("tool:b")),
		});
		await controller.load();
		const first = controller.toggleSelected();
		await controller.toggleSelected();
		release();
		await first;
		expect(updates).toBe(1);
		await controller.refresh([tool("tool:b")]);
	});
	test("close waits pending work and blocks new work", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const controller = createLoadoutController({
			storage: storage({}, async () => gate),
			inventory: inventory(tool("tool:a")),
		});
		await controller.load();
		const toggle = controller.toggleSelected();
		const closing = controller.close();
		expect(controller.state.closed).toBe(true);
		release();
		await Promise.all([toggle, closing]);
		expect(() => controller.setQuery("a")).toThrow("closed");
	});
});
