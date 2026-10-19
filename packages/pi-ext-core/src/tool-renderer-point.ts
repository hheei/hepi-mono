import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { createExtensionPointKey, readExtensionHooks } from "./extension-point.js";
import { getGlobalState } from "./global-state.js";
import { agentResultText } from "./tool-result.js";

/** Optional UI decorates native tool renderers; tool packages retain their fallback. */
export type ToolRendererFactory = (name: string, native: ToolRenderers) => ToolRenderers;

export const toolRendererPoint = createExtensionPointKey<ToolRendererFactory>(
	"@hheei/pi-ext-ui/tool-renderer",
);

function ownedRenderCalls(): WeakMap<NonNullable<ToolRenderers["renderCall"]>, ToolRenderers> {
	return getGlobalState("optional-tool-render-calls", () => new WeakMap());
}

/** Internal unwrapping preserves tool presentation metadata on the definition. */
export function getOptionalToolNativeRenderers(
	renderers: ToolRenderers,
): ToolRenderers | undefined {
	return renderers.renderCall === undefined
		? undefined
		: ownedRenderCalls().get(renderers.renderCall);
}

/** Lets host-wide resolvers delegate to package-owned renderers without a second frame. */
export function hasOptionalToolRenderers(renderers: ToolRenderers | undefined): boolean {
	return renderers?.renderCall !== undefined && ownedRenderCalls().has(renderers.renderCall);
}

/** Resolve at render time: package load order and session cleanup cannot retain an old UI. */
export function createOptionalToolRenderers(
	pi: ExtensionAPI,
	name: string,
	native: ToolRenderers,
): ToolRenderers {
	const resolve = (): ToolRenderers =>
		readExtensionHooks(pi, toolRendererPoint)[0]?.(name, native) ?? native;
	const renderCall: NonNullable<ToolRenderers["renderCall"]> = (args, theme, context) => {
		const render = resolve().renderCall ?? native.renderCall;
		return render?.(args, theme, context) ?? new Text(theme.fg("toolTitle", name), 0, 0);
	};
	ownedRenderCalls().set(renderCall, native);
	return {
		renderShell: "self",
		renderCall,
		renderResult(result, options, theme, context) {
			const render = resolve().renderResult ?? native.renderResult;
			return (
				render?.(result, options, theme, context) ??
				new Text(stripTerminalSequences(agentResultText(result)), 0, 0)
			);
		},
	};
}
