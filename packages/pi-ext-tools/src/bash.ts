import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { SelectableBashResult } from "./selectable-bash-result.js";

const OWNER = "@hheei/pi-ext-tools";

/** Keeps Pi's bash renderer authoritative, adding selection only to expanded output rows. */
export function registerBashTool(pi: ExtensionAPI): void {
	const template = createBashToolDefinition(process.cwd());
	const components = new WeakMap<object, SelectableBashResult>();
	const upstreamComponents = new WeakMap<object, Component>();
	const tool: typeof template = {
		...template,
		renderResult: (result, options, theme, context) => {
			const state = context.state;
			const previous = upstreamComponents.get(state);
			const upstream = template.renderResult?.(result, options, theme, {
				...context,
				lastComponent: previous,
			});
			if (upstream === undefined) throw new Error("Pi bash renderer unavailable");
			upstreamComponents.set(state, upstream);
			if (!options.expanded) {
				components.get(state)?.dispose();
				return upstream;
			}
			const component = components.get(state) ?? new SelectableBashResult();
			components.set(state, component);
			let output = result.content
				.filter((part) => part.type === "text")
				.map((part) => ("text" in part ? part.text : ""))
				.join("\n")
				.trim();
			const truncation = result.details?.truncation;
			const fullOutputPath = result.details?.fullOutputPath;
			if (
				!options.isPartial &&
				truncation?.truncated === true &&
				typeof fullOutputPath === "string" &&
				output.endsWith("]")
			) {
				const footerStart = output.lastIndexOf("\n\n[");
				if (footerStart >= 0 && output.slice(footerStart).includes(fullOutputPath))
					output = output.slice(0, footerStart).trimEnd();
			}
			component.set(upstream, output, theme, context);
			return component;
		},
		async execute(toolCallId, params, signal, onUpdate, context) {
			return createBashToolDefinition(context.cwd).execute(
				toolCallId,
				params,
				signal,
				onUpdate,
				context,
			);
		},
	};
	registerManagedLoadoutTool(
		pi,
		{
			id: "bash",
			owner: OWNER,
			group: "Tools",
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
		tool,
	);
}
