import type {
	AgentToolResult,
	ExtensionAPI,
	Theme,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { getGlobalState } from "./global-state.js";
import { runtimeIdentity } from "./runtime-identity.js";
import { getOptionalToolNativeRenderers } from "./tool-renderer-point.js";
import { agentResultText } from "./tool-result.js";

export type ToolPresentationStatus = "none" | "streaming" | "running" | "ok" | "warn" | "error";

export interface ToolPresentationSection {
	readonly railToken: "accent" | "muted" | "dim" | "success" | "error";
	readonly content: string | readonly string[] | Component;
}

export type ToolPresentationContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

/**
 * One nested call a container executed. Facts only: a provider states what ran, and the consumer
 * decides how to list it, so no consumer has to parse another package's private details.
 */
export interface ToolPresentationChild {
	readonly id?: string;
	readonly title: string;
	readonly summary?: string;
	readonly status?: ToolPresentationStatus;
	readonly durationMs?: number;
	/** Plain result text, so a consumer can show the child without re-running its provider. */
	readonly detail?: string;
}

/** Content belongs to the tool; optional consumers own its interactive frame. */
export interface BaseToolPresentation {
	readonly summary: string;
	readonly status?: ToolPresentationStatus;
	readonly sections?: readonly ToolPresentationSection[];
	/** Container/patch results replace their streaming call header as soon as available. */
	readonly replaceCallOnPartial?: boolean;
	readonly request?: string;
	readonly output?: string;
	readonly collapsedRows?: readonly string[];
	/** Nested calls this container executed, in execution order. */
	readonly children?: readonly ToolPresentationChild[];
	/**
	 * How many nested calls the container actually made. `children` is a display list a provider may
	 * bound; this is the fact a consumer counts, so a bounded list cannot understate the work.
	 */
	readonly childCount?: number;
	readonly copy?: { readonly primary: string; readonly full?: string };
}

export interface TextToolPresentation extends BaseToolPresentation {
	readonly kind?: "text";
}

export interface DiffToolPresentation extends BaseToolPresentation {
	readonly kind: "diff";
	readonly path: string;
	readonly diff: string;
	readonly stats?: { readonly additions: number; readonly deletions: number };
}

export type ToolPresentation = TextToolPresentation | DiffToolPresentation;

export type ToolPresentationProvider = (
	args: unknown,
	result: AgentToolResult<unknown> | undefined,
	theme: Theme,
	context: ToolPresentationContext,
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
	const renderCall: RenderCall = (args, theme, context) => {
		const presentation = present(args, undefined, theme, context);
		const header = `${theme.fg("toolTitle", theme.bold(title))} ${stripTerminalSequences(presentation.summary)}`;
		const request = presentation.request;
		return new Text(request ? `${header}\n${stripTerminalSequences(request)}` : header, 0, 0);
	};
	providers().set(renderCall, present);
	namedRenderers(pi).set(title, new WeakRef(renderCall));
	return {
		renderCall,
		renderResult(result, _options, theme, context) {
			const presentation = present(context.args, result, theme, context);
			const isError = context.isError || result.isError === true;
			let output: string;
			if (isError) {
				output = agentResultText(result);
			} else if (presentation.kind === "diff") {
				output = presentation.output ?? presentation.diff;
			} else {
				output = presentation.output ?? agentResultText(result);
			}
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
	if (renderers?.renderCall === undefined) return undefined;
	const native = getOptionalToolNativeRenderers(renderers);
	return native === undefined
		? providers().get(renderers.renderCall)
		: getToolPresentationProvider(native);
}

/** Nested calls have no host-mounted renderer; resolve their owner in this Pi runtime. */
export function getRegisteredToolPresentationProvider(
	pi: ExtensionAPI,
	title: string,
): ToolPresentationProvider | undefined {
	const renderers = namedRenderers(pi);
	const renderCall = renderers.get(title)?.deref();
	if (renderCall !== undefined) {
		return providers().get(renderCall);
	}
	renderers.delete(title);
	return undefined;
}
