import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ExtensionRuntimeHost = Pick<ExtensionAPI, "events">;

export function extensionRuntimeIdentity(pi: ExtensionRuntimeHost): object {
	const events: unknown = pi.events;
	return typeof events === "object" && events !== null ? events : pi;
}
