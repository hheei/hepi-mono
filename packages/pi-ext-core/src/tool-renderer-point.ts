import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { createExtensionPointKey, readExtensionHooks } from "./extension-point.js";
import { getGlobalState } from "./global-state.js";
import { runtimeIdentity } from "./runtime-identity.js";
import { agentResultText } from "./tool-result.js";

/** Optional UI decorates native tool renderers; tool packages retain their fallback. */
export type ToolRendererFactory = (name: string, native: ToolRenderers) => ToolRenderers;

export const toolRendererPoint = createExtensionPointKey<ToolRendererFactory>(
	"@hheei/pi-ext-ui/tool-renderer",
);

function ownedRenderCalls(): WeakMap<NonNullable<ToolRenderers["renderCall"]>, ToolRenderers> {
	return getGlobalState("optional-tool-render-calls", () => new WeakMap());
}

function namedNativeRenderers(pi: ExtensionAPI): Map<string, WeakRef<ToolRenderers>> {
	const runtimes = getGlobalState(
		"named-native-tool-renderers",
		() => new WeakMap<object, Map<string, WeakRef<ToolRenderers>>>(),
	);
	const identity = runtimeIdentity(pi);
	let current = runtimes.get(identity);
	if (current === undefined) {
		current = new Map();
		runtimes.set(identity, current);
	}
	return current;
}

/** Resolves native-style renderers registered via createOptionalToolRenderers. */
export function getRegisteredToolRenderers(
	pi: ExtensionAPI,
	name: string,
): ToolRenderers | undefined {
	const ref = namedNativeRenderers(pi).get(name);
	const target = ref?.deref();
	if (target === undefined) {
		namedNativeRenderers(pi).delete(name);
		return undefined;
	}
	return target;
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
	namedNativeRenderers(pi).set(name, new WeakRef(native));
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
