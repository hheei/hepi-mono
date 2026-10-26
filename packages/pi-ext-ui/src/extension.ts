import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	messageViewPoint,
	registerExtensionHook,
	registerExtensionLifecycle,
	toolRendererPoint,
} from "@hheei/pi-ext-core";
import { installHostToolGroups } from "./host-transcript-patch.js";
import { createMessageView } from "./message-view.js";
import { createOptionalToolRendererFactory, registerCollapsibleToolRenderer } from "./renderer.js";
import { clearCapturedNestedCalls } from "./tracker.js";

export default function (pi: ExtensionAPI): void {
	pi.registerFlag("ui-tool-groups", {
		type: "boolean",
		default: false,
		description: "Group tool summaries, thinking and notifications (Pi >=1.0.1 runtime patch)",
	});
	let redrawGroups: (() => void) | undefined;
	pi.on("agent_settled", () => redrawGroups?.());
	registerCollapsibleToolRenderer(pi);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-ui",
		start(context) {
			if (context.extension.mode === "tui" && pi.getFlag("ui-tool-groups") === true) {
				try {
					const patch = installHostToolGroups(context.extension);
					redrawGroups = patch.requestRender;
					context.resources.add("tool-groups", () => {
						redrawGroups = undefined;
						patch.dispose();
					});
				} catch (error) {
					context.extension.ui.notify(
						error instanceof Error ? error.message : String(error),
						"warning",
					);
				}
			}
			context.resources.add("tracker-cleanup", () => {
				clearCapturedNestedCalls();
			});
			const toolRenderers = registerExtensionHook(
				pi,
				toolRendererPoint,
				createOptionalToolRendererFactory(pi),
			);
			context.resources.add("tool-renderer", () => toolRenderers.dispose());
			const handle = registerExtensionHook(context.pi, messageViewPoint, createMessageView);
			context.resources.add("message-view", () => handle.dispose());
		},
	});
}
