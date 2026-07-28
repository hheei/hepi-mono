import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HepiLifecycleController,
	type HepiLoadoutGroup,
	registerHepiLifecycle,
	registerHepiRuntimeLoadoutGroup,
} from "../../hepi-basics/src/core/index.js";
import { HepiAftRuntime } from "./aft/runtime.js";
import { registerAftTools } from "./aft/tools.js";

export type HepiExtension = (pi: ExtensionAPI) => void;

const AFT_LOADOUT_GROUP = {
	id: "aft",
	label: "AFT",
	items: ["aft_outline", "aft_zoom"],
} as const satisfies HepiLoadoutGroup;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function registerHepiAft(pi: ExtensionAPI): void {
	let runtime: HepiAftRuntime | undefined;
	registerAftTools(pi, () => runtime);
	registerHepiRuntimeLoadoutGroup(pi, AFT_LOADOUT_GROUP);

	const lifecycle = new HepiLifecycleController({
		onStart: async (session) => {
			const activeRuntime = new HepiAftRuntime();
			try {
				await activeRuntime.start();
			} catch (error) {
				if (session.ctx.hasUI)
					session.ctx.ui.notify(`AFT unavailable: ${errorMessage(error)}`, "warning");
				return;
			}
			runtime = activeRuntime;
			session.registry.registerLifecycle({
				id: "aft-runtime",
				cleanup: async () => {
					await activeRuntime.dispose();
					if (runtime === activeRuntime) runtime = undefined;
				},
			});
		},
	});
	registerHepiLifecycle(pi, lifecycle, "hepi-aft");
}

export const hepiAftExtensions: readonly HepiExtension[] = [registerHepiAft];

export default function piHepiAftExtension(pi: ExtensionAPI): void {
	for (const extension of hepiAftExtensions) extension(pi);
}
