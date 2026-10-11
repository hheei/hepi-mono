import type { ExtensionLifecycleContext } from "@hheei/pi-ext-core";
import { provideService, TASK_REGISTRY_SERVICE_KEY, TaskRegistry } from "@hheei/pi-ext-core";
import type { BgBashJobRegistry } from "./bg-bash-jobs.js";
import { startTaskDelivery } from "./task-delivery.js";

/**
 * Starts the session task registry and binds terminal delivery plus optional
 * background Bash reminders. Exposes the registry as a shared service for
 * other extensions (e.g. pi-subagents).
 */
export function startTaskControl(
	context: ExtensionLifecycleContext,
	jobs?: BgBashJobRegistry,
): TaskRegistry {
	const registry = new TaskRegistry();
	const stopDelivery = startTaskDelivery({
		pi: context.pi,
		registry,
		...(jobs === undefined ? {} : { jobs }),
		session: context.extension,
		signal: context.signal,
		notify: (message, level) => context.extension.ui.notify(message, level),
	});
	if (!provideService(context, TASK_REGISTRY_SERVICE_KEY, registry)) {
		stopDelivery();
		registry.dispose();
		throw new Error("Another extension already provides the task registry service");
	}
	context.resources.add("task-control", () => {
		stopDelivery();
		registry.dispose();
	});
	return registry;
}
