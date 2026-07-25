import { describe, expect, test } from "bun:test";
import { createLoadoutController } from "../../../src/controller.js";
import type { LoadoutItem } from "../../../src/model.js";
import type { LoadoutStorage } from "../../../src/storage.js";

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
	test("selects the first source group before MCP entries", async () => {
		const mcp: LoadoutItem = {
			key: "mcp:docs",
			name: "docs",
			kind: "mcp",
			sourceScope: "global",
			hasGlobalDefinition: true,
			origin: "docs-mcp",
		};
		const controller = createLoadoutController({
			storage: storage(),
			inventory: inventory(mcp, { ...tool("tool:bash"), origin: "builtin" }),
		});
		await controller.load();
		expect(controller.state.selectedKey).toBe("tool:bash");
		await controller.close();
	});

	test("limits selection to the active view", async () => {
		const skill: LoadoutItem = {
			key: "skill:docs",
			name: "docs",
			kind: "skill",
			sourceScope: "global",
			hasGlobalDefinition: true,
			origin: "test",
		};
		const controller = createLoadoutController({
			storage: storage(),
			inventory: inventory(tool("tool:alpha"), skill),
		});
		await controller.load();
		expect(controller.state.selectedKey).toBe("tool:alpha");
		controller.setView("skills");
		expect(controller.state.selectedKey).toBe("skill:docs");
		controller.moveSelection(1);
		expect(controller.state.selectedKey).toBe("skill:docs");
		await controller.close();
	});

	test("keeps selection at the list boundaries", async () => {
		const controller = createLoadoutController({
			storage: storage(),
			inventory: inventory(tool("tool:alpha"), tool("tool:beta")),
		});
		await controller.load();
		controller.moveSelection(-1);
		expect(controller.state.selectedKey).toBe("tool:alpha");
		controller.moveSelection(1);
		controller.moveSelection(1);
		expect(controller.state.selectedKey).toBe("tool:beta");
		await controller.close();
	});

	test("persists only the canonical identity", async () => {
		const writes: Array<{ key: string; value: boolean | undefined }> = [];
		const item = { ...tool("tool:extension:read"), name: "read" };
		const controller = createLoadoutController({
			storage: {
				load: async () => ({ global: {}, project: {} }),
				update: async (_scope, key, value) => {
					writes.push({ key, value });
				},
			},
			inventory: inventory(item),
		});
		await controller.load();
		await controller.toggleSelected();
		expect(writes).toEqual([{ key: "tool:read", value: false }]);
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

	test("close aborts pending storage work", async () => {
		let aborted = false;
		const controller = createLoadoutController({
			storage: storage({}, async (_scope, _key, _value, signal) => {
				await new Promise<void>((_resolve, reject) => {
					if (signal?.aborted) {
						aborted = true;
						reject(signal.reason);
						return;
					}
					signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(signal.reason);
						},
						{ once: true },
					);
				});
			}),
			inventory: inventory(tool("tool:a")),
		});
		await controller.load();
		const toggle = controller.toggleSelected();
		await Bun.sleep(0);
		await Promise.all([toggle, controller.close()]);
		expect(aborted).toBe(true);
	});

	test("close propagates abort through rollback and recovery", async () => {
		let loadCalls = 0;
		let updateCalls = 0;
		let rollbackSignal: AbortSignal | undefined;
		let recoverySignal: AbortSignal | undefined;
		let runtimeStarted: () => void = () => undefined;
		const runtimeGate = new Promise<void>((resolve) => {
			runtimeStarted = resolve;
		});
		const controller = createLoadoutController({
			storage: {
				load: async (signal) => {
					loadCalls++;
					if (loadCalls > 1) {
						recoverySignal = signal;
						signal?.throwIfAborted();
					}
					return { global: {}, project: {} };
				},
				update: async (_scope, _key, _value, signal) => {
					updateCalls++;
					if (updateCalls > 1) {
						rollbackSignal = signal;
						signal?.throwIfAborted();
					}
				},
			},
			inventory: inventory(tool("tool:a")),
			runtime: {
				tool: async (items, signal) => {
					if (items[0]?.effectiveStatus !== "disabled") return;
					runtimeStarted();
					await new Promise<void>((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				},
			},
		});
		await controller.load();
		const toggle = controller.toggleSelected();
		await runtimeGate;
		await Promise.all([toggle, controller.close()]);

		expect(rollbackSignal?.aborted).toBe(true);
		expect(recoverySignal?.aborted).toBe(true);
	});
});
