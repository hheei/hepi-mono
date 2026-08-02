import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getToolResultLayout, registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { createFffRuntimeState, type FffRuntimeState } from "./fff/lifecycle.js";
import { SelectableReadResult } from "./selectable-read-result.js";

const OWNER = "@hheei/pi-ext-tools";

/** Registers read with Pi-owned result geometry while recreating execution for the call cwd. */
export function registerReadTool(
	pi: ExtensionAPI,
	state: FffRuntimeState = createFffRuntimeState(),
): void {
	const template = createReadToolDefinition(process.cwd());
	const tool: typeof template = {
		...template,
		renderResult: (result, options, theme, context) => {
			const layout = getToolResultLayout(context);
			if (layout === undefined) {
				const renderUpstream = template.renderResult;
				if (renderUpstream === undefined) throw new Error("Pi read renderer unavailable");
				return renderUpstream(result, options, theme, context);
			}
			const component =
				context.lastComponent instanceof SelectableReadResult
					? context.lastComponent
					: new SelectableReadResult();
			const output = result.content
				.filter((part) => part.type === "text")
				.map((part) => ("text" in part ? part.text : ""))
				.join("\n");
			component.setResult(options.expanded || context.isError ? output : "", theme);
			component.bindLayout(layout);
			return component;
		},
		async execute(toolCallId, params, signal, onUpdate, context) {
			const original = createReadToolDefinition(context.cwd);
			if (!state.getSettings().readEnhancement)
				return original.execute(toolCallId, params, signal, onUpdate, context);
			const runtime = state.getRuntime();
			if (!runtime) return original.execute(toolCallId, params, signal, onUpdate, context);
			try {
				const resolved = await runtime.resolvePath(params.path, { allowDirectory: false });
				if (resolved.isErr())
					return original.execute(toolCallId, params, signal, onUpdate, context);
				return original.execute(
					toolCallId,
					{ ...params, path: resolved.value.relativePath },
					signal,
					onUpdate,
					context,
				);
			} catch {
				return original.execute(toolCallId, params, signal, onUpdate, context);
			}
		},
	};
	registerManagedLoadoutTool(
		pi,
		{
			id: "read",
			owner: OWNER,
			group: "Tools",
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
		tool,
	);
}
