import type {
	AgentToolResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import {
	type ApplyPatchInWorkspaceResult,
	applyPatchThroughCoordinator,
} from "./apply-patch/index.js";
import {
	finishApplyPatchRenderState,
	renderApplyPatchCall,
	setApplyPatchRenderState,
} from "./apply-patch/renderer.js";

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
	const rejectedOperationCount = new Set(
		result.rejected.flatMap((rejection) => rejection.operationIndices),
	).size;
	const status =
		rejectedOperationCount === 0
			? "Success"
			: result.changedPaths.length === 0
				? "Failed"
				: "Partial";
	const headline =
		status === "Success"
			? "Done! Applied patch."
			: status === "Partial"
				? "Applied patch partially."
				: "Patch was not applied.";
	return [
		headline,
		`Status: ${status}`,
		`Files changed: ${result.changedPaths.length}`,
		`Operations: ${result.operationCount}`,
		`Exact updates: ${result.exactUpdateCount}`,
		`Fuzzy updates: ${result.fuzzyUpdateCount}`,
		`Fuzzy matching: ${result.fuzzyUpdateCount > 0 ? "used" : "not used"}`,
		`Rejected operations: ${rejectedOperationCount}`,
		...result.rejected.flatMap((rejection) => [
			`Rejected paths: ${rejection.paths.join(", ")}`,
			`Reason: ${rejection.error}`,
		]),
	].join("\n");
}

export function createApplyPatchTool(): ToolDefinition<
	typeof APPLY_PATCH_PARAMETERS,
	ApplyPatchToolDetails,
	unknown
> {
	return {
		name: "apply_patch",
		label: "apply_patch",
		description: "Apply a strict Codex V4A patch through the pi-ext-tools patch coordinator.",
		parameters: APPLY_PATCH_PARAMETERS,
		executionMode: "parallel",
		renderCall: (args, theme, context) => renderApplyPatchCall(args, theme, context),
		renderResult: (_result, { isPartial }, theme) => {
			if (isPartial) return new Text(`${theme.fg("warning", "◐")} ${theme.bold("Patching")}`, 0, 0);
			return new Container();
		},
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const { patch } = parseApplyPatchParameters(params);
			setApplyPatchRenderState(toolCallId);
			if (/artifact:\/\//.test(patch)) {
				finishApplyPatchRenderState(toolCallId, "failed");
				throw new Error("apply_patch cannot modify artifact URLs");
			}
			try {
				const result = await applyPatchThroughCoordinator({
					workspaceRoot: ctx.cwd,
					patch,
					...(signal === undefined ? {} : { signal }),
				});
				const failedOperationIndices = result.rejected.flatMap(
					(rejection) => rejection.operationIndices,
				);
				const status =
					failedOperationIndices.length === 0
						? "success"
						: result.changedPaths.length === 0
							? "failed"
							: "partial";
				finishApplyPatchRenderState(toolCallId, status, failedOperationIndices);
				return {
					content: [{ type: "text", text: formatApplyPatchResult(result) }],
					details: {
						status: "success",
						changedPaths: result.changedPaths,
						operationCount: result.operationCount,
						exactUpdateCount: result.exactUpdateCount,
						fuzzyUpdateCount: result.fuzzyUpdateCount,
						rejected: result.rejected,
					},
				} satisfies AgentToolResult<ApplyPatchToolDetails>;
			} catch (error) {
				finishApplyPatchRenderState(toolCallId, "failed");
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
