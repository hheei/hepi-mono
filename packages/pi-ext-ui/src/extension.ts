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
import { ToolUiRuntime } from "./runtime.js";
import {
	activityGroupsEnabled,
	createToolGroupSettings,
	toolBackgroundsEnabled,
} from "./settings.js";
import { TOOL_SPINNER_INTERVAL_MS } from "./tool-view.js";

export default function (pi: ExtensionAPI): void {
	// One runtime per extension instance: two Pi runtimes in one process never share these facts.
	const runtime = new ToolUiRuntime();
	let redrawGroups: (() => void) | undefined;
	pi.on("agent_settled", () => redrawGroups?.());
	registerCollapsibleToolRenderer(pi, runtime);
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
			const applyBackgrounds = (enabled: boolean): void => {
				runtime.backgrounds = enabled;
				redrawGroups?.();
			};
			const provider = createToolGroupSettings({
				onEnabled: apply,
				onBackgrounds: applyBackgrounds,
			});
			const onAgentStart = pi.on("agent_start", () => {
				patch?.beginRun();
				redrawGroups?.();
			});
			// A live tool animates its status glyph. The ticker exists only while one is running, and the
			// frame itself comes from one shared clock, so a phase never restarts on a status change.
			let liveTools = 0;
			let ticker: ReturnType<typeof setInterval> | undefined;
			const stopTicker = (): void => {
				if (ticker === undefined) return;
				clearInterval(ticker);
				ticker = undefined;
			};
			const onAgentEnd = pi.on("agent_end", () => {
				patch?.endRun();
				// No tool outlives the agent loop, so the animation cannot keep a ticker alive either.
				liveTools = 0;
				stopTicker();
				redrawGroups?.();
			});
			const onToolStart = pi.on("tool_execution_start", () => {
				liveTools += 1;
				if (ticker !== undefined) return;
				ticker = setInterval(() => {
					if (liveTools === 0 || redrawGroups === undefined) {
						stopTicker();
						return;
					}
					redrawGroups();
				}, TOOL_SPINNER_INTERVAL_MS);
			});
			const onToolEnd = pi.on("tool_execution_end", () => {
				liveTools = Math.max(0, liveTools - 1);
				if (liveTools === 0) stopTicker();
			});
			context.resources.add("run-clock", () => {
				onAgentStart();
				onAgentEnd();
				onToolStart();
				onToolEnd();
				stopTicker();
				liveTools = 0;
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
				runtime.tracker.clear();
			});
			// Resume reads the host's own nested-call record for the current branch, never another one.
			runtime.nestedCalls.setSource(context.extension.sessionManager);
			context.resources.add("nested-call-source", () => {
				runtime.nestedCalls.setSource(undefined);
			});
			const toolRenderers = registerExtensionHook(
				pi,
				toolRendererPoint,
				createOptionalToolRendererFactory(pi, runtime),
			);
			context.resources.add("tool-renderer", () => toolRenderers.dispose());
			const handle = registerExtensionHook(context.pi, messageViewPoint, createMessageView);
			context.resources.add("message-view", () => handle.dispose());
			try {
				const state = await provider.storage.load({
					sessionId: context.extension.sessionManager.getSessionId(),
					signal: context.signal,
				});
				if (!context.signal.aborted) {
					apply(activityGroupsEnabled(state));
					applyBackgrounds(toolBackgroundsEnabled(state));
				}
			} catch (error) {
				if (!context.signal.aborted) {
					const detail = error instanceof Error ? error.message : String(error);
					context.extension.ui.notify(
						`Tool activity groups settings unreadable: ${detail}`,
						"warning",
					);
					apply(true);
					applyBackgrounds(false);
				}
			}
		},
	});
}
