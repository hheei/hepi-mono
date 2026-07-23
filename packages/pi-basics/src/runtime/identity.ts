import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function extensionRuntimeIdentity(pi: ExtensionAPI): object {
	const events: unknown = pi.events;
	return typeof events === "object" && events !== null ? events : pi;
}
