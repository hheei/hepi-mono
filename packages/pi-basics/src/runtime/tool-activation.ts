import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ToolActivationCoordinator {
	setLoadoutBaseline(names: readonly string[]): void;
	setAskVisible(visible: boolean): void;
	isConfigured(toolName: string): boolean;
	isEffective(toolName: string): boolean;
	dispose(): void;
	reset(): void;
}

function unique(names: readonly string[]): string[] {
	return [...new Set(names)];
}

function createCoordinator(getPi: () => ExtensionAPI): ToolActivationCoordinator {
	let baseline: string[] = [];
	let askVisible = false;
	let disposed = false;
	let effective: string[] = [];

	const recompute = (): void => {
		if (disposed) return;
		const next = baseline.filter((name) => name !== "ask" || askVisible);
		if (next.length === effective.length && next.every((name, index) => name === effective[index]))
			return;
		const pi = getPi();
		if (typeof pi.setActiveTools === "function") pi.setActiveTools([...next]);
		effective = next;
	};
	recompute();

	return {
		setLoadoutBaseline(names) {
			if (disposed) return;
			baseline = unique(names);
			recompute();
		},
		setAskVisible(visible) {
			if (disposed) return;
			askVisible = visible;
			recompute();
		},
		isConfigured(toolName) {
			return !disposed && baseline.includes(toolName);
		},
		isEffective(toolName) {
			return !disposed && effective.includes(toolName);
		},
		dispose() {
			disposed = true;
			baseline = [];
			askVisible = false;
			effective = [];
		},
		reset() {
			disposed = false;
			baseline = [];
			askVisible = false;
			effective = [];
		},
	};
}

export function createToolActivationCoordinator(pi: ExtensionAPI): ToolActivationCoordinator {
	return createCoordinator(() => pi);
}

class GlobalCoordinatorState {
	readonly coordinator: ToolActivationCoordinator;

	constructor(public pi: ExtensionAPI) {
		this.coordinator = createCoordinator(() => this.pi);
	}
}

declare global {
	var __hepiToolActivationCoordinatorState: GlobalCoordinatorState | undefined;
}

export function getToolActivationCoordinator(pi: ExtensionAPI): ToolActivationCoordinator {
	const existing = globalThis.__hepiToolActivationCoordinatorState;
	if (existing !== undefined) {
		existing.pi = pi;
		return existing.coordinator;
	}
	const created = new GlobalCoordinatorState(pi);
	globalThis.__hepiToolActivationCoordinatorState = created;
	return created.coordinator;
}
