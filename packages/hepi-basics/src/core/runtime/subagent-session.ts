import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extensionRuntimeIdentity } from "./identity.js";

export interface PiSubagentSessionBridge {
	readonly isSubagentSession: () => boolean;
}

declare global {
	var __piSubagentSessionBridgesByRuntime: WeakMap<object, PiSubagentSessionBridge> | undefined;
}

/** True when Pi Subagents identified this runtime as one of its child sessions. */
export function isHepiSubagentSession(pi: ExtensionAPI): boolean {
	return (
		globalThis.__piSubagentSessionBridgesByRuntime
			?.get(extensionRuntimeIdentity(pi))
			?.isSubagentSession() ?? false
	);
}
