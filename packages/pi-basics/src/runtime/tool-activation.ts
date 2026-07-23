import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extensionRuntimeIdentity } from "./identity.js";

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

interface RebindableToolActivationCoordinator extends ToolActivationCoordinator {
	bind(pi: ExtensionAPI): void;
}

const coordinators = new WeakMap<object, RebindableToolActivationCoordinator>();

function createRebindableToolActivationCoordinator(
	pi: ExtensionAPI,
): RebindableToolActivationCoordinator {
	let host = pi;
	let baseline: string[] = [];
	let askVisible = false;
	let disposed = false;
	let effective: string[] = [];

	const recompute = (): void => {
		if (disposed) return;
		const next = baseline.filter((name) => name !== "ask" || askVisible);
		if (next.length === effective.length && next.every((name, index) => name === effective[index]))
			return;
		if (typeof host.setActiveTools === "function") host.setActiveTools([...next]);
		effective = next;
	};
	recompute();

	return {
		bind(nextHost) {
			host = nextHost;
		},
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
	return createRebindableToolActivationCoordinator(pi);
}

export function getToolActivationCoordinator(pi: ExtensionAPI): ToolActivationCoordinator {
	const identity = extensionRuntimeIdentity(pi);
	const existing = coordinators.get(identity);
	if (existing !== undefined) {
		existing.bind(pi);
		return existing;
	}
	const coordinator = createRebindableToolActivationCoordinator(pi);
	coordinators.set(identity, coordinator);
	return coordinator;
}
