import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getRuntimeSettingsRegistry,
	messageViewPoint,
	registerExtensionHook,
	registerExtensionLifecycle,
	registerSettings,
	toolRendererPoint,
} from "@hheei/pi-ext-core";
import { installHostToolGroups } from "./host-transcript-patch.js";
import { createMessageView } from "./message-view.js";
import { createOptionalToolRendererFactory, registerCollapsibleToolRenderer } from "./renderer.js";
import { activityGroupsEnabled, createToolGroupSettings } from "./settings.js";
import { clearCapturedNestedCalls } from "./tracker.js";

export default function (pi: ExtensionAPI): void {
	let redrawGroups: (() => void) | undefined;
	pi.on("agent_settled", () => redrawGroups?.());
	registerCollapsibleToolRenderer(pi);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-ui",
		async start(context) {
			let patch:
				| { dispose(): void; requestRender(): void; beginRun(): void; endRun(): void }
				| undefined;
			const apply = (enabled: boolean): void => {
				if (context.extension.mode !== "tui") return;
				if (!enabled) {
					redrawGroups = undefined;
					patch?.dispose();
					patch = undefined;
					return;
				}
				if (patch !== undefined) return;
				try {
					patch = installHostToolGroups(context.extension);
					redrawGroups = patch.requestRender;
				} catch (error) {
					context.extension.ui.notify(
						error instanceof Error ? error.message : String(error),
						"warning",
					);
				}
			};
			const provider = createToolGroupSettings({ onEnabled: apply });
			const onAgentStart = pi.on("agent_start", () => {
				patch?.beginRun();
				redrawGroups?.();
			});
			const onAgentEnd = pi.on("agent_end", () => {
				patch?.endRun();
				redrawGroups?.();
			});
			context.resources.add("run-clock", () => {
				onAgentStart();
				onAgentEnd();
			});
			context.resources.add(
				"tool-group-settings",
				registerSettings(provider, getRuntimeSettingsRegistry(pi)),
			);
			context.resources.add("tool-groups", () => {
				redrawGroups = undefined;
				patch?.dispose();
				patch = undefined;
			});
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
			try {
				const state = await provider.storage.load({
					sessionId: context.extension.sessionManager.getSessionId(),
					signal: context.signal,
				});
				if (!context.signal.aborted) apply(activityGroupsEnabled(state));
			} catch (error) {
				if (!context.signal.aborted) {
					const detail = error instanceof Error ? error.message : String(error);
					context.extension.ui.notify(
						`Tool activity groups settings unreadable: ${detail}`,
						"warning",
					);
					apply(true);
				}
			}
		},
	});
}
