import type { ExtensionLifecycleContext } from "./lifecycle.js";

function addResourceCleanup(
	resources: ExtensionLifecycleContext["resources"],
	id: string,
	cleanup: () => void,
): void {
	try {
		resources.add(id, cleanup);
	} catch (error) {
		if (error instanceof Error && error.message === `Cleanup id already registered: ${id}`) return;
		throw error;
	}
}

/**
 * Toggles a set of tool names in Pi's active tools for the given session lifecycle context.
 * When active, adds the tools and registers a lifecycle resource cleanup that removes them on session exit.
 * When inactive, removes the tools from Pi's active tools.
 */
export function setSessionToolsActive(
	context: ExtensionLifecycleContext,
	toolNames: readonly string[],
	active: boolean,
): void {
	const ids = [...new Set(toolNames)];
	const apply = (enabled: boolean): void => {
		const next = new Set(context.pi.getActiveTools());
		for (const id of ids) next.delete(id);
		if (enabled) for (const id of ids) next.add(id);
		context.pi.setActiveTools([...next]);
	};
	apply(active);
	if (!active) return;
	addResourceCleanup(context.resources, `session-tools:${ids.join(",")}`, () => apply(false));
}
