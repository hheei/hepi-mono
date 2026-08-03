import type {
	AgentToolResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getToolResultLayout, registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import {
	type ApplyPatchInWorkspaceResult,
	applyPatchThroughCoordinator,
} from "./apply-patch/index.js";
import { SelectableToolTextResult, selectableToolText } from "./selectable-tool-text-result.js";

const OWNER = "@hheei/pi-ext-tools";

export const APPLY_PATCH_PARAMETERS = Type.Object(
	{
		patch: Type.String({
			description:
				"Full Codex V4A patch text. Must use *** Begin Patch / *** End Patch with Add File, Update File, Delete File, and optional Move to sections.",
		}),
	},
	{ additionalProperties: false },
);

type ApplyPatchParameters = Static<typeof APPLY_PATCH_PARAMETERS>;

export interface ApplyPatchToolDetails extends ApplyPatchInWorkspaceResult {
	readonly status: "success";
}

function parseApplyPatchParameters(params: unknown): ApplyPatchParameters {
	if (
		typeof params !== "object" ||
		params === null ||
		Array.isArray(params) ||
		Object.keys(params).length !== 1 ||
		!("patch" in params) ||
		typeof params.patch !== "string"
	)
		throw new Error("apply_patch requires exactly one string parameter: patch");
	return { patch: params.patch };
}

function formatApplyPatchResult(result: ApplyPatchInWorkspaceResult): string {
	return [
		"Done! Applied patch.",
		`Files changed: ${result.changedPaths.length}`,
		`Operations: ${result.operationCount}`,
		`Exact updates: ${result.exactUpdateCount}`,
		`Fuzzy updates: ${result.fuzzyUpdateCount}`,
	].join("\n");
}

export function createApplyPatchTool(): ToolDefinition<
	typeof APPLY_PATCH_PARAMETERS,
	ApplyPatchToolDetails,
	unknown
> {
	const components = new WeakMap<object, SelectableToolTextResult>();
	return {
		name: "apply_patch",
		label: "apply_patch",
		description: "Apply a strict Codex V4A patch through the pi-ext-tools patch coordinator.",
		parameters: APPLY_PATCH_PARAMETERS,
		executionMode: "parallel",
		renderResult: (result, _options, theme, context) => {
			const selectableText = selectableToolText(
				result,
				{ expanded: true },
				Number.MAX_SAFE_INTEGER,
			);
			const upstream = new Text(theme.fg("toolOutput", selectableText), 0, 0);
			const layout = getToolResultLayout(context);
			const state = context.state;
			if (typeof state !== "object" || state === null) return upstream;
			if (layout === undefined) {
				components.get(state)?.dispose();
				return upstream;
			}
			const component = components.get(state) ?? new SelectableToolTextResult();
			components.set(state, component);
			component.set({
				upstream,
				selectableText,
				theme,
				layout,
				offsetY: 0,
			});
			return component;
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { patch } = parseApplyPatchParameters(params);
			try {
				const result = await applyPatchThroughCoordinator({
					workspaceRoot: ctx.cwd,
					patch,
					...(signal === undefined ? {} : { signal }),
				});
				return {
					content: [{ type: "text", text: formatApplyPatchResult(result) }],
					details: {
						status: "success",
						changedPaths: result.changedPaths,
						operationCount: result.operationCount,
						exactUpdateCount: result.exactUpdateCount,
						fuzzyUpdateCount: result.fuzzyUpdateCount,
					},
				} satisfies AgentToolResult<ApplyPatchToolDetails>;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`apply_patch failed: ${message}`);
			}
		},
	};
}

export function registerApplyPatchTool(pi: ExtensionAPI): void {
	registerManagedLoadoutTool(
		pi,
		{
			id: "apply_patch",
			owner: OWNER,
			group: "Built-in",
			origin: OWNER,
			priority: 100,
			conflictSets: [],
			conflictsWith: ["edit", "write"],
			defaultActive: true,
		},
		createApplyPatchTool(),
	);
}
