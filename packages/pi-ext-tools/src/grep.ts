import { createGrepToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { getToolResultLayout, registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { grepNeedsBuiltinFallback, inferFffGrepMode } from "./fff/extension-common.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { SelectableToolTextResult, selectableToolText } from "./selectable-tool-text-result.js";

const OWNER = "@hheei/pi-ext-tools";
export function registerGrepTool(pi: ExtensionAPI, state: FffRuntimeState): void {
	const template = createGrepToolDefinition(process.cwd());
	const components = new WeakMap<object, SelectableToolTextResult>();
	const upstreamComponents = new WeakMap<object, Component>();
	const tool: typeof template = {
		...template,
		renderResult: (result, options, theme, context) => {
			const previous = upstreamComponents.get(context.state);
			const upstream = template.renderResult?.(result, options, theme, {
				...context,
				lastComponent: previous,
			});
			if (upstream === undefined) throw new Error("Pi grep renderer unavailable");
			upstreamComponents.set(context.state, upstream);
			const layout = getToolResultLayout(context);
			if (layout === undefined) {
				components.get(context.state)?.dispose();
				return upstream;
			}
			const component = components.get(context.state) ?? new SelectableToolTextResult();
			components.set(context.state, component);
			component.set({
				upstream,
				selectableText: selectableToolText(result, options, 15),
				theme,
				layout,
				offsetY: 1,
			});
			return component;
		},
		async execute(id, params, signal, onUpdate, context) {
			const original = createGrepToolDefinition(context.cwd);
			const native = () => original.execute(id, params, signal, onUpdate, context);
			const runtime = state.getRuntime();
			if (
				!runtime ||
				!state.getSettings().grepEnhancement ||
				grepNeedsBuiltinFallback({
					pattern: params.pattern,
					...(params.ignoreCase === undefined ? {} : { ignoreCase: params.ignoreCase }),
				})
			)
				return native();
			try {
				const result = await runtime.grepSearch({
					pattern: params.pattern,
					mode: inferFffGrepMode(params.literal),
					...(params.path === undefined ? {} : { pathQuery: params.path }),
					...(params.glob === undefined ? {} : { glob: params.glob }),
					...(params.context === undefined ? {} : { context: params.context }),
					...(params.limit === undefined ? {} : { limit: params.limit }),
				});
				if (result.isErr()) return native();
				return {
					content: [{ type: "text" as const, text: result.value.formatted }],
					details: undefined,
				};
			} catch {
				return native();
			}
		},
	};
	registerManagedLoadoutTool(
		pi,
		{
			id: "grep",
			owner: OWNER,
			group: "Tools",
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
		tool,
	);
}
