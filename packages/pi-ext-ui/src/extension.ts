import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	messageViewPoint,
	registerExtensionHook,
	registerExtensionLifecycle,
} from "@hheei/pi-ext-core";
import { createMessageView } from "./message-view.js";
import { registerCollapsibleToolRenderer } from "./renderer.js";

export default function (pi: ExtensionAPI): void {
	registerCollapsibleToolRenderer(pi);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-ui",
		start(context) {
			const handle = registerExtensionHook(context.pi, messageViewPoint, createMessageView);
			context.resources.add("message-view", () => handle.dispose());
		},
	});
}
