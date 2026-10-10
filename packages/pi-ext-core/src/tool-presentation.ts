import type {
	AgentToolResult,
	ExtensionAPI,
	Theme,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { getGlobalState } from "./global-state.js";
import { runtimeIdentity } from "./runtime-identity.js";
import { agentResultText } from "./tool-result.js";

/** Content belongs to the tool; optional consumers own its interactive frame. */
export interface ToolPresentation {
	readonly summary: string;
	readonly request?: string;
	readonly output?: string;
	readonly collapsedRows?: readonly string[];
	readonly copy?: { readonly primary: string; readonly full?: string };
}

export type ToolPresentationProvider = (
	args: unknown,
	result: AgentToolResult<unknown> | undefined,
	theme: Theme,
) => ToolPresentation;

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;

function providers(): WeakMap<RenderCall, ToolPresentationProvider> {
	return getGlobalState("tool-presentations", () => new WeakMap());
}

function namedRenderers(pi: ExtensionAPI): Map<string, WeakRef<RenderCall>> {
	const runtimes = getGlobalState(
		"named-tool-presentations",
		() => new WeakMap<object, Map<string, WeakRef<RenderCall>>>(),
	);
	const identity = runtimeIdentity(pi);
	let current = runtimes.get(identity);
	if (current === undefined) {
		current = new Map();
		runtimes.set(identity, current);
	}
	return current;
}

/** Always supplies native renderers; provider references never retain a tool definition. */
export function createToolPresentationRenderers(
	pi: ExtensionAPI,
	title: string,
	present: ToolPresentationProvider,
): ToolRenderers {
	const renderCall: RenderCall = (args, theme) => {
		const presentation = present(args, undefined, theme);
		const header = `${theme.fg("toolTitle", theme.bold(title))} ${stripTerminalSequences(presentation.summary)}`;
		const request = presentation.request;
		return new Text(request ? `${header}\n${stripTerminalSequences(request)}` : header, 0, 0);
	};
	providers().set(renderCall, present);
	namedRenderers(pi).set(title, new WeakRef(renderCall));
	return {
		renderCall,
		renderResult(result, _options, theme, context) {
			const presentation = present(context.args, result, theme);
			const isError = context.isError || result.isError === true;
			const output = isError
				? agentResultText(result)
				: (presentation.output ?? agentResultText(result));
			return new Text(
				theme.fg(isError ? "error" : "toolOutput", stripTerminalSequences(output)),
				0,
				0,
			);
		},
	};
}

export function getToolPresentationProvider(
	renderers: ToolRenderers | undefined,
): ToolPresentationProvider | undefined {
	return renderers?.renderCall === undefined ? undefined : providers().get(renderers.renderCall);
}

/** Nested calls have no host-mounted renderer; resolve their owner in this Pi runtime. */
export function getRegisteredToolPresentationProvider(
	pi: ExtensionAPI,
	title: string,
): ToolPresentationProvider | undefined {
	const renderers = namedRenderers(pi);
	const renderCall = renderers.get(title)?.deref();
	if (renderCall === undefined) {
		renderers.delete(title);
		return undefined;
	}
	return providers().get(renderCall);
}
