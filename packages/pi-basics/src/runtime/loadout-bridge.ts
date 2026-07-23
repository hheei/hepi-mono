import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HePiMaybePromise } from "../api/modules.js";

interface LoadoutBridgeState {
	disabledSkillKeys: ReadonlySet<string>;
	readonly toolDisableHandlers: Map<string, () => HePiMaybePromise<void>>;
}

declare global {
	var __hepiLoadoutBridgeState: LoadoutBridgeState | undefined;
}

function stateFor(_pi: ExtensionAPI): LoadoutBridgeState {
	const existing = globalThis.__hepiLoadoutBridgeState;
	if (existing !== undefined) return existing;
	const created: LoadoutBridgeState = {
		disabledSkillKeys: new Set(),
		toolDisableHandlers: new Map(),
	};
	globalThis.__hepiLoadoutBridgeState = created;
	return created;
}

export function hePiLoadoutKey(kind: string, name: string, source?: string): string {
	return source === undefined ? `${kind}:${name}` : `${kind}:${source}:${name}`;
}

export function setHePiDisabledSkillKeys(pi: ExtensionAPI, keys: ReadonlySet<string>): void {
	stateFor(pi).disabledSkillKeys = new Set(keys);
}

export function isHePiSkillEnabled(pi: ExtensionAPI, name: string, source?: string): boolean {
	return !stateFor(pi).disabledSkillKeys.has(hePiLoadoutKey("skill", name, source));
}

export function registerHePiToolDisableHandler(
	pi: ExtensionAPI,
	toolName: string,
	handler: () => HePiMaybePromise<void>,
): () => void {
	const state = stateFor(pi);
	state.toolDisableHandlers.set(toolName, handler);
	return () => {
		if (state.toolDisableHandlers.get(toolName) === handler)
			state.toolDisableHandlers.delete(toolName);
	};
}

export async function disableHePiTool(pi: ExtensionAPI, toolName: string): Promise<void> {
	await stateFor(pi).toolDisableHandlers.get(toolName)?.();
}
