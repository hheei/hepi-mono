import { describe, expect, test } from "bun:test";
import {
	createToolActivationCoordinator,
	getToolActivationCoordinator,
} from "../../src/runtime/tool-activation.js";

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

describe("tool activation coordinator", () => {
	test("shares state across per-extension API wrappers", () => {
		const writes: string[][] = [];
		const loadoutApi = { setActiveTools: (names: string[]) => writes.push(names) } as never;
		const goalApi = { setActiveTools: (names: string[]) => writes.push(names) } as never;
		const loadoutCoordinator = getToolActivationCoordinator(loadoutApi);
		const goalCoordinator = getToolActivationCoordinator(goalApi);
		loadoutCoordinator.reset();
		loadoutCoordinator.setLoadoutBaseline(["goal"]);
		expect(goalCoordinator).toBe(loadoutCoordinator);
		expect(goalCoordinator.isConfigured("goal")).toBe(true);
		expect(writes.at(-1)).toEqual(["goal"]);
		goalCoordinator.dispose();
	});

	test("does not access host actions during construction", () => {
		const { getActiveToolsCalls } = host();
		expect(getActiveToolsCalls()).toBe(0);
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
