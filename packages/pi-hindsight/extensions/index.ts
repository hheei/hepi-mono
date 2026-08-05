import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { registerHindsightSettings } from "./config/hepi-settings.js";
import { createMemoryLifecycle } from "./lifecycle/memory-lifecycle.js";
import { registerTools } from "./operations/tools.js";
import { registerCommands } from "./tui/commands.js";

export default function hindsightExtension(pi: ExtensionAPI): void {
	const lifecycle = createMemoryLifecycle(process.cwd());
	let lifecycleSignal: AbortSignal | undefined;
	const active = (): boolean => lifecycleSignal !== undefined && !lifecycleSignal.aborted;

	registerTools(pi, lifecycle.deps);
	registerCommands(pi, lifecycle.deps, active);

	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-hindsight",
		start: async (context) => {
			lifecycleSignal = context.signal;
			context.resources.add("hindsight-active-session", () => {
				if (lifecycleSignal === context.signal) lifecycleSignal = undefined;
			});
			// Register before startup so a failed bank initialization still stops timers and flushes safely.
			context.resources.add("hindsight-memory-lifecycle", () =>
				lifecycle.shutdown(context.extension),
			);
			context.resources.add("hindsight-settings", registerHindsightSettings(pi));
			await lifecycle.initialize(context.extension);
		},
	});

	// Pi retains raw handlers across reload. The session signal makes older module instances inert.
	pi.on("context", async (event, ctx) => (active() ? lifecycle.recall(event, ctx) : undefined));

	pi.on("agent_end", async (event, ctx) => {
		if (!active()) return;
		await lifecycle.retain(event, ctx);
	});
}
