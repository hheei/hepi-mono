import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { SelectableReadResult } from "./selectable-read-result.js";

const OWNER = "@hheei/pi-ext-tools";

/** Registers read with Pi-owned result geometry while recreating execution for the call cwd. */
export function registerReadTool(pi: ExtensionAPI): void {
	const template = createReadToolDefinition(process.cwd());
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
		{
			...template,
			renderResult: (result, options, theme, context) => {
				const component =
					context.lastComponent instanceof SelectableReadResult
						? context.lastComponent
						: new SelectableReadResult();
				const output = result.content
					.filter((part) => part.type === "text")
					.map((part) => ("text" in part ? part.text : ""))
					.join("\n");
				component.setResult(options.expanded || context.isError ? output : "", theme);
				component.bindLayout(context);
				return component;
			},
			async execute(toolCallId, params, signal, onUpdate, context) {
				return createReadToolDefinition(context.cwd).execute(
					toolCallId,
					params,
					signal,
					onUpdate,
					context,
				);
			},
		},
	);
}
