import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HepiLifecycleController,
	registerHepiLifecycle,
	registerHepiToolDisableHandler,
} from "../../../hepi-basics/src/core/index.js";
import { createSshfsFeature } from "./index.js";

export default function piSshfsExtension(pi: ExtensionAPI): void {
	const feature = createSshfsFeature(pi);
	const lifecycle = new HepiLifecycleController({
		onStart: async (runtime) => {
			const unregisterDisableHandler = registerHepiToolDisableHandler(pi, "sshfs", () =>
				feature.dispose(),
			);
			runtime.registry.registerLifecycle({
				id: "sshfs",
				cleanup: async () => {
					unregisterDisableHandler();
					await feature.dispose();
				},
			});
		},
	});
	registerHepiLifecycle(pi, lifecycle, "pi-sshfs");
}
