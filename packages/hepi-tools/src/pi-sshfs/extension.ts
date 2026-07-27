import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HepiLifecycleController,
	registerHepiLifecycle,
} from "../../../hepi-basics/src/core/index.js";
import { createSshfsFeature } from "./index.js";

export default function piSshfsExtension(pi: ExtensionAPI): void {
	const feature = createSshfsFeature(pi);
	const lifecycle = new HepiLifecycleController({
		onStart: async (runtime) => {
			runtime.registry.registerLifecycle({ id: "sshfs", cleanup: () => feature.dispose() });
		},
	});
	registerHepiLifecycle(pi, lifecycle);
}
