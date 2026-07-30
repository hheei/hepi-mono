import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extensionRuntimeIdentity } from "../core/runtime/identity.js";
import { isHepiSubagentSession } from "../core/runtime/subagent-session.js";

type IntegrationRegistration = {
	readonly token: symbol;
	cleanup?: () => void;
};

declare global {
	var __hepiIntegrationRegistrations:
		| WeakMap<object, Map<string, IntegrationRegistration>>
		| undefined;
}

export function registerHepiIntegration(
	pi: ExtensionAPI,
	key: string,
	setup: (isCurrent: () => boolean) => () => void,
): void {
	let registrations = globalThis.__hepiIntegrationRegistrations;
	if (registrations === undefined) {
		registrations = new WeakMap();
		globalThis.__hepiIntegrationRegistrations = registrations;
	}
	const identity = extensionRuntimeIdentity(pi);
	let runtime = registrations.get(identity);
	if (runtime === undefined) {
		runtime = new Map();
		registrations.set(identity, runtime);
	}
	runtime.get(key)?.cleanup?.();
	const registration: IntegrationRegistration = { token: Symbol(key) };
	runtime.set(key, registration);
	const isCurrent = (): boolean =>
		runtime?.get(key)?.token === registration.token && !isHepiSubagentSession(pi);
	registration.cleanup = setup(isCurrent);
}
