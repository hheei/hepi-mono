import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ToolActivationCoordinator {
	setLoadoutBaseline(names: readonly string[]): void;
	setAskVisible(visible: boolean): void;
	setGoalVisible(visible: boolean): void;
	isConfigured(toolName: string): boolean;
	isEffective(toolName: string): boolean;
	dispose(): void;
}

function unique(names: readonly string[]): string[] {
	return [...new Set(names)];
}

export function createToolActivationCoordinator(pi: ExtensionAPI): ToolActivationCoordinator {
	let baseline: string[] = [];
	let askVisible = false;
	let goalVisible = false;
	let disposed = false;
	let effective: string[] = [];

	const recompute = (): void => {
		if (disposed) return;
		const next = baseline.filter(
			(name) => (name !== "ask" || askVisible) && (name !== "goal" || goalVisible),
		);
		if (next.length === effective.length && next.every((name, index) => name === effective[index]))
			return;
		effective = next;
		if (typeof pi.setActiveTools === "function") pi.setActiveTools([...effective]);
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
		setGoalVisible(visible) {
			if (disposed) return;
			goalVisible = visible;
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
			effective = [];
		},
	};
}
