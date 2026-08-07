import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type RuntimeHost = Pick<ExtensionAPI, "events">;

// Pi 0.84 gives each extension runner a fresh events facade on reload even
// though all facades delegate to one host event bus. The host is process-scoped
// (one active extension runtime), so callable facades share this identity;
// plain test doubles still use their own object identity.
const piHostRuntimeIdentity = {};

/**
 * Resolves the object used to scope core state to one Pi runtime. Pi retains some
 * handlers across /reload, so the stable `events` object is preferred over the
 * newly created extension API object; the API itself is the fallback for hosts
 * without an object-valued event bus.
 */
export function runtimeIdentity(pi: RuntimeHost): object {
	const events: unknown = pi.events;
	if (typeof events !== "object" || events === null) return pi;
	if (
		typeof Reflect.get(events, "emit") === "function" &&
		typeof Reflect.get(events, "on") === "function"
	) {
		return piHostRuntimeIdentity;
	}
	return events;
}
