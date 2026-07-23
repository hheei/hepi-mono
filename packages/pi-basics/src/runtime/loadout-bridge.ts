import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HePiMaybePromise } from "../api/modules.js";
import { extensionRuntimeIdentity } from "./identity.js";

interface LoadoutBridgeState {
	disabledSkillKeys: ReadonlySet<string>;
	readonly toolDisableHandlers: Map<string, () => HePiMaybePromise<void>>;
}

const states = new WeakMap<object, LoadoutBridgeState>();

function stateFor(pi: ExtensionAPI): LoadoutBridgeState {
	const identity = extensionRuntimeIdentity(pi);
	const existing = states.get(identity);
	if (existing !== undefined) return existing;
	const state: LoadoutBridgeState = {
		disabledSkillKeys: new Set(),
		toolDisableHandlers: new Map(),
	};
	states.set(identity, state);
	return state;
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
	if (!toolName.trim()) throw new Error("HEPI tool disable handler name must not be empty");
	const state = stateFor(pi);
	if (state.toolDisableHandlers.has(toolName))
		throw new Error(`HEPI tool disable handler already exists: ${toolName}`);
	state.toolDisableHandlers.set(toolName, handler);
	return () => {
		if (state.toolDisableHandlers.get(toolName) === handler)
			state.toolDisableHandlers.delete(toolName);
	};
}

export async function disableHePiTool(pi: ExtensionAPI, toolName: string): Promise<void> {
	await stateFor(pi).toolDisableHandlers.get(toolName)?.();
}
