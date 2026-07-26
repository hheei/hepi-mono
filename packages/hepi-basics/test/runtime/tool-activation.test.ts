import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createToolActivationCoordinator,
	getToolActivationCoordinator,
} from "../../src/core/runtime/tool-activation.js";

function host(initial: string[] = ["read", "ask", "goal"]) {
	const activeSets: string[][] = [];
	let getActiveToolsCalls = 0;
	const pi = {
		getActiveTools: () => {
			getActiveToolsCalls++;
			return [...initial];
		},
		setActiveTools: (names: string[]) => activeSets.push(names),
	} as never;
	return {
		coordinator: createToolActivationCoordinator(pi),
		activeSets,
		getActiveToolsCalls: () => getActiveToolsCalls,
	};
}

function sharedRuntimeApis(events = { emit() {}, on: () => () => undefined }): {
	readonly first: ExtensionAPI;
	readonly second: ExtensionAPI;
	readonly firstWrites: string[][];
	readonly secondWrites: string[][];
} {
	const firstWrites: string[][] = [];
	const secondWrites: string[][] = [];
	return {
		first: {
			events,
			setActiveTools: (names: string[]) => {
				firstWrites.push(names);
			},
		} as unknown as ExtensionAPI,
		second: {
			events,
			setActiveTools: (names: string[]) => {
				secondWrites.push(names);
			},
		} as unknown as ExtensionAPI,
		firstWrites,
		secondWrites,
	};
}

describe("tool activation coordinator", () => {
	test("does not access host actions during construction", () => {
		const { getActiveToolsCalls } = host();
		expect(getActiveToolsCalls()).toBe(0);
	});

	test("shares state across extension APIs and rebinds host actions", () => {
		const { first, second, firstWrites, secondWrites } = sharedRuntimeApis();
		const fromFirst = getToolActivationCoordinator(first);
		const fromSecond = getToolActivationCoordinator(second);
		expect(fromSecond).toBe(fromFirst);
		fromFirst.setLoadoutBaseline(["read", "goal"]);
		expect(firstWrites).toEqual([]);
		expect(secondWrites).toEqual([["read", "goal"]]);
	});

	test("rebinds after reload on the same event bus", () => {
		const { first, second, firstWrites, secondWrites } = sharedRuntimeApis();
		const beforeReload = getToolActivationCoordinator(first);
		beforeReload.setLoadoutBaseline(["read"]);
		beforeReload.dispose();

		const afterReload = getToolActivationCoordinator(second);
		expect(afterReload).toBe(beforeReload);
		afterReload.reset();
		afterReload.setLoadoutBaseline(["goal"]);
		expect(firstWrites).toEqual([["read"]]);
		expect(secondWrites).toEqual([["goal"]]);
	});

	test("isolates coordinators from different Pi runtimes", () => {
		const firstRuntime = sharedRuntimeApis();
		const secondRuntime = sharedRuntimeApis();
		expect(getToolActivationCoordinator(firstRuntime.first)).not.toBe(
			getToolActivationCoordinator(secondRuntime.first),
		);
	});
	test("masks Ask without removing configured Goal", () => {
		const { coordinator, activeSets } = host(["read", "goal"]);
		coordinator.setLoadoutBaseline(["read", "goal", "ask"]);
		expect(activeSets.at(-1)).toEqual(["read", "goal"]);
		coordinator.setAskVisible(true);
		expect(activeSets.at(-1)).toEqual(["read", "goal", "ask"]);
		coordinator.setLoadoutBaseline(["read"]);
		expect(coordinator.isConfigured("goal")).toBe(false);
		expect(coordinator.isEffective("goal")).toBe(false);
		expect(activeSets.at(-1)).toEqual(["read"]);
	});

	test("keeps the previous effective tools when host update fails", () => {
		const writes: string[][] = [];
		let rejectWrites: boolean = false;
		const pi = {
			setActiveTools: (names: string[]) => {
				if (rejectWrites) throw new Error("host rejected tools");
				writes.push(names);
			},
		} as never;
		const coordinator = createToolActivationCoordinator(pi);
		coordinator.setLoadoutBaseline(["goal"]);
		rejectWrites = true;
		expect(() => coordinator.setLoadoutBaseline([])).toThrow("host rejected tools");
		expect(coordinator.isEffective("goal")).toBe(true);
		expect(writes).toEqual([["goal"]]);
	});

	test("does not rewrite unchanged effective set and dispose blocks writes", () => {
		const { coordinator, activeSets } = host();
		coordinator.setLoadoutBaseline(["read", "ask", "goal"]);
		const count = activeSets.length;
		coordinator.setLoadoutBaseline(["read", "ask", "goal", "goal"]);
		expect(activeSets).toHaveLength(count);
		coordinator.dispose();
		coordinator.setAskVisible(true);
		expect(activeSets).toHaveLength(count);
	});
});
