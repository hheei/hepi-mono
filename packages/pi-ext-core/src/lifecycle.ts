import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDisposerRegistry, type DisposerRegistry } from "./disposer-registry.js";
import { getGlobalState } from "./global-state.js";
import { createOutputRegistry, type OutputRegistry } from "./output.js";
import { runtimeIdentity } from "./runtime-identity.js";
import { abortServiceWaiters } from "./service.js";

/**
 * One session-scoped owner view. The signal is aborted before resource cleanup;
 * consumers must treat it as the authority for cancelling async work created from
 * this context rather than retaining the Pi context after shutdown or reload.
 */
export interface ExtensionLifecycleContext {
	readonly pi: ExtensionAPI;
	readonly extension: ExtensionContext;
	readonly signal: AbortSignal;
	readonly resources: DisposerRegistry;
	readonly outputs: OutputRegistry;
}

export interface ExtensionLifecycleOptions {
	/** Stable extension package name, used to replace stale Pi reload handlers. */
	readonly key: string;
	/** Creates session-owned resources. Failure triggers registered cleanup. */
	readonly start: (context: ExtensionLifecycleContext) => void | Promise<void>;
}

/** Registers one session-scoped lifecycle owner for an extension package. */
export function registerExtensionLifecycle(
	pi: ExtensionAPI,
	options: ExtensionLifecycleOptions,
): void {
	if (!options.key.trim()) throw new Error("Extension lifecycle key must not be empty");
	const registrations = getLifecycleRegistrations(pi);
	const previous = registrations.get(options.key);
	const replacement = previous?.shutdown() ?? Promise.resolve();
	// Keep replacement failures observable by the next start without creating an
	// unhandled rejection when no subsequent session starts.
	void replacement.catch(() => undefined);
	const controller = createLifecycleController(pi, options, replacement);
	const registration: LifecycleRegistration = {
		token: Symbol(options.key),
		shutdown: controller.shutdown,
	};
	registrations.set(options.key, registration);
	const isCurrent = (): boolean => registrations.get(options.key)?.token === registration.token;

	// Pi does not unregister old handlers on /reload. The runtime-scoped token
	// makes stale handlers inert while the newest registration owns the session.
	pi.on("session_start", async (_event, context) => {
		if (!isCurrent()) return;
		await controller.start(context);
	});
	pi.on("session_shutdown", async () => {
		if (!isCurrent()) return;
		await controller.shutdown();
	});
}

interface ActiveLifecycle {
	readonly controller: AbortController;
	readonly resources: DisposerRegistry;
}

interface LifecycleRegistration {
	readonly token: symbol;
	readonly shutdown: () => Promise<void>;
}

function getLifecycleRegistrations(pi: ExtensionAPI): Map<string, LifecycleRegistration> {
	const registrations = getGlobalState(
		"lifecycle-registrations",
		(): WeakMap<object, Map<string, LifecycleRegistration>> => new WeakMap(),
	);
	const identity = runtimeIdentity(pi);
	const current = registrations.get(identity);
	if (current !== undefined) return current;
	const created = new Map<string, LifecycleRegistration>();
	registrations.set(identity, created);
	return created;
}

function createLifecycleController(
	pi: ExtensionAPI,
	options: ExtensionLifecycleOptions,
	replacement: Promise<void>,
): {
	start(context: ExtensionContext): Promise<void>;
	shutdown(): Promise<void>;
} {
	let active: ActiveLifecycle | undefined;
	let transition = Promise.resolve();

	// Pi awaits lifecycle handlers serially, so start/shutdown must share one
	// queue. This also prevents an old shutdown from closing a newly started scope.
	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = transition.then(operation);
		transition = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	const shutdownUnlocked = async (): Promise<void> => {
		const current = active;
		if (current === undefined) return;
		active = undefined;
		current.controller.abort();
		abortServiceWaiters(pi);
		const failures = await current.resources.cleanup();
		if (failures.length > 0) {
			throw new AggregateError(
				failures.map((failure) => failure.error),
				`Extension lifecycle cleanup failed: ${failures.map((failure) => failure.id).join(", ")}`,
			);
		}
	};

	return {
		start(context: ExtensionContext): Promise<void> {
			return enqueue(async () => {
				await replacement;
				if (active !== undefined) await shutdownUnlocked();
				const controller = new AbortController();
				const resources = createDisposerRegistry();
				const outputs = createOutputRegistry();
				resources.add("outputs", () => outputs.dispose());
				const created: ActiveLifecycle = { controller, resources };
				active = created;
				try {
					await options.start({
						pi,
						extension: context,
						signal: controller.signal,
						resources,
						outputs,
					});
				} catch (error) {
					active = undefined;
					controller.abort();
					const failures = await resources.cleanup();
					if (failures.length > 0) {
						throw new AggregateError(
							[error, ...failures.map((failure) => failure.error)],
							`Extension lifecycle start failed: ${failures.map((failure) => failure.id).join(", ")}`,
							{ cause: error },
						);
					}
					throw error;
				}
			});
		},
		shutdown: (): Promise<void> =>
			enqueue(async () => {
				await replacement;
				await shutdownUnlocked();
			}),
	};
}
