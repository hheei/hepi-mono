import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HePiLifecycleController,
	registerHePiLifecycle,
} from "../../../hepi-basics/src/core/index.js";
import { createSshfsFeature } from "./index.js";

export default function piSshfsExtension(pi: ExtensionAPI): void {
	const feature = createSshfsFeature(pi);
	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
			runtime.registry.registerLifecycle({ id: "sshfs", cleanup: () => feature.dispose() });
		},
	});
	registerHePiLifecycle(pi, lifecycle);
}
