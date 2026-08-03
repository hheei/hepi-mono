import { createFindToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { getToolResultLayout, registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { SelectableToolTextResult, selectableToolText } from "./selectable-tool-text-result.js";

/** ponytail: keep native find until FFF can preserve glob/path/result contract. */
export function registerFindTool(pi: ExtensionAPI, _state: FffRuntimeState): void {
	const template = createFindToolDefinition(process.cwd());
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
			if (upstream === undefined) throw new Error("Pi find renderer unavailable");
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
				selectableText: selectableToolText(result, options, 20),
				theme,
				layout,
				offsetY: 1,
			});
			return component;
		},
		async execute(id, params, signal, onUpdate, context) {
			return createFindToolDefinition(context.cwd).execute(id, params, signal, onUpdate, context);
		},
	};
	registerManagedLoadoutTool(
		pi,
		{
			id: "find",
			owner: "@hheei/pi-ext-tools",
			group: "Tools",
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
		tool,
	);
}
