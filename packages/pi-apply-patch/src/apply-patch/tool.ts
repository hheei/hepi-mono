import type {
	AgentToolResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	createOptionalToolRenderers,
	createRenderThrottle,
	createToolPresentationRenderers,
	defaultExtensionSettingsPaths,
	errorMessage,
	textToolResult,
} from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import {
	type ApplyPatchInWorkspaceResult,
	type ApplyPatchProgress,
	type ApplyPatchRejection,
	applyPatchInWorkspace,
	CONFIRMED_STATUSES,
	loadApplyPatchPolicy,
} from "./index.js";
import { isPatchPathOutsideWorkspace } from "./paths.js";
import { applyPatchPresentation } from "./presentation.js";

const MAX_CANDIDATES = 6;
const APPLY_PATCH_DESCRIPTION = "Apply a V4A patch to files (32 MiB per file).";
const APPLY_PATCH_PARAMETER_DESCRIPTION =
	"One unfenced *** Begin Patch / *** End Patch envelope with Add/Update/Delete File sections. Paths may be absolute or workspace-relative.";
const APPLY_PATCH_PROMPT_SNIPPET = "Apply related file changes in one V4A patch.";
const APPLY_PATCH_PROMPT_GUIDELINES = [
	"apply_patch: use @@ text anchors or *** End of File; pure moves use *** Move to: without a hunk.",
	"apply_patch: confirmed changes persist after failure or cancellation.",
];
export const APPLY_PATCH_PARAMETERS = Type.Object(
	{
		patch: Type.String({ description: APPLY_PATCH_PARAMETER_DESCRIPTION }),
	},
	{ additionalProperties: false },
);

type ApplyPatchParameters = Static<typeof APPLY_PATCH_PARAMETERS>;
export type ApplyPatchStatus = "success" | "partial" | "failed";

export interface ApplyPatchToolDetails extends ApplyPatchInWorkspaceResult {
	readonly status: ApplyPatchStatus;
	readonly progress?: ApplyPatchProgress;
}

export function isApplyPatchToolDetails(value: unknown): value is ApplyPatchToolDetails {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		"status" in value &&
		((value as { readonly status: unknown }).status === "success" ||
			(value as { readonly status: unknown }).status === "partial" ||
			(value as { readonly status: unknown }).status === "failed")
	);
}

export function parseApplyPatchParameters(params: unknown): ApplyPatchParameters {
	if (typeof params !== "object" || params === null || Array.isArray(params))
		throw new Error("apply_patch requires exactly one string parameter: patch");
	const keys = Object.keys(params);
	if (keys.length !== 1 || !("patch" in params) || typeof params.patch !== "string")
		throw new Error("apply_patch requires exactly one string parameter: patch");
	return { patch: params.patch };
}

function statusFor(result: ApplyPatchInWorkspaceResult): ApplyPatchStatus {
	if (
		!result.rejected.some((rejection) => rejection.operationIndices.length > 0) &&
		result.unconfirmed.length === 0 &&
		result.notApplied.length === 0
	)
		return "success";
	return result.changedPaths.length === 0 ? "failed" : "partial";
}

function operationText(index: number): string {
	return `operation ${index + 1}`;
}

function rejectionLines(rejection: ApplyPatchRejection): readonly string[] {
	const operation = rejection.operationIndices.map(operationText).join(", ");
	const path = rejection.paths.join(", ");
	const prefix = `- ${operation}, ${path}`;
	if (rejection.diagnostics.length === 0) return [`${prefix}: ${rejection.error}`];
	return rejection.diagnostics.map((diagnostic) => {
		switch (diagnostic.kind) {
			case "context_not_found":
				return diagnostic.hint !== undefined
					? `${prefix}, hunk ${diagnostic.hunkIndex}: context not found (${diagnostic.hint})`
					: `${prefix}, hunk ${diagnostic.hunkIndex}: context not found`;
			case "ambiguous_exact":
				return `${prefix}, hunk ${diagnostic.hunkIndex}: exact context is ambiguous at lines ${diagnostic.candidateStartLines
					.slice(0, MAX_CANDIDATES)
					.join(", ")} (${diagnostic.candidateStartLines.length} candidates)`;
			default:
				throw new Error(`Unknown patch diagnostic: ${String(diagnostic)}`);
		}
	});
}

export function formatApplyPatchResult(result: ApplyPatchInWorkspaceResult): string {
	const status = statusFor(result);
	const rejectedHunksByOperation = new Map<number, number>();
	for (const rejection of result.rejected)
		if (rejection.diagnostics.length > 0)
			for (const operationIndex of rejection.operationIndices)
				rejectedHunksByOperation.set(
					operationIndex,
					(rejectedHunksByOperation.get(operationIndex) ?? 0) + rejection.diagnostics.length,
				);
	const applied = result.applied.map((operation) => {
		const path = operation.paths.at(-1) ?? "<unknown>";
		const rejectedHunks = rejectedHunksByOperation.get(operation.operationIndex) ?? 0;
		const totalHunks = operation.outcomes.length + rejectedHunks;
		return `- ${path}: ${operation.kind}${totalHunks === 0 ? "" : ` (${operation.outcomes.length}/${totalHunks} hunks applied)`}`;
	});
	const fuzzy = result.applied.flatMap((operation) =>
		operation.outcomes
			.filter((outcome) => outcome.match === "fuzzy")
			.map(
				(outcome) =>
					`- ${operation.paths.at(-1) ?? "unknown"}, ${operationText(operation.operationIndex)}, hunk ${outcome.hunkIndex}: lines ${outcome.startLine}-${outcome.startLine + outcome.length - 1}, fuzzy`,
			),
	);
	const headline =
		status === "success"
			? `Applied patch: ${result.applied.length} operations in ${result.changedPaths.length} files.`
			: status === "partial"
				? "Patch partially applied."
				: "Patch was not applied.";
	return [
		headline,
		...(applied.length === 0 ? [] : ["Changed:", ...applied]),
		...(fuzzy.length === 0 ? [] : ["Fuzzy-applied:", ...fuzzy]),
		...(result.rejected.length === 0
			? []
			: ["Rejected:", ...result.rejected.flatMap(rejectionLines)]),
		...(result.unconfirmed.length === 0
			? []
			: ["Unconfirmed:", ...result.unconfirmed.flatMap(rejectionLines)]),
		...(result.notApplied.length === 0
			? []
			: ["NotApplied:", ...result.notApplied.flatMap(rejectionLines)]),
	].join("\n");
}

function externalPathWarning(workspaceRoot: string, result: ApplyPatchInWorkspaceResult): string {
	const paths = [
		...new Set(
			result.changedPaths.filter((path) => isPatchPathOutsideWorkspace(workspaceRoot, path)),
		),
	];
	return paths.length === 0
		? ""
		: `\nWarning: changed path outside the workspace: ${paths.join(", ")}`;
}

function progressDetails(progress: ApplyPatchProgress): ApplyPatchToolDetails {
	return {
		// Live details report confirmed writes only, the same rows the header totals count.
		changedPaths: progress.operations
			.filter((operation) => CONFIRMED_STATUSES.has(operation.status))
			.map((operation) => operation.path),
		addedLines: progress.addedLines,
		removedLines: progress.removedLines,
		operations: progress.operations,
		operationCount: progress.operations.length,
		exactUpdateCount: 0,
		fuzzyUpdateCount: 0,
		applied: [],
		rejected: [],
		unconfirmed: [],
		notApplied: [],
		status: "success",
		progress,
	};
}

export function createApplyPatchTool(): ToolDefinition<
	typeof APPLY_PATCH_PARAMETERS,
	ApplyPatchToolDetails,
	unknown
> {
	return {
		name: "apply_patch",
		label: "apply_patch",
		description: APPLY_PATCH_DESCRIPTION,
		parameters: APPLY_PATCH_PARAMETERS,
		promptSnippet: APPLY_PATCH_PROMPT_SNIPPET,
		promptGuidelines: APPLY_PATCH_PROMPT_GUIDELINES,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { patch } = parseApplyPatchParameters(params);
			// One operation per repaint used to rebuild the whole operation table. A patch with many
			// operations now repaints on the shared streaming window; the returned result stays the
			// only authority for the finished call.
			let latestProgress: ApplyPatchProgress | undefined;
			const repaint = createRenderThrottle(() => {
				const progress = latestProgress;
				if (progress === undefined) return;
				onUpdate?.({ content: [], details: progressDetails(progress) });
			});
			try {
				const policy = await loadApplyPatchPolicy({
					paths: defaultExtensionSettingsPaths(ctx.cwd),
					...(signal === undefined ? {} : { signal }),
				});
				const result = await applyPatchInWorkspace({
					workspaceRoot: ctx.cwd,
					patch,
					policy,
					...(signal === undefined ? {} : { signal }),
					onProgress: (progress) => {
						latestProgress = progress;
						repaint.request();
					},
				});
				const warning = externalPathWarning(ctx.cwd, result);
				const status = statusFor(result);
				const isError = status !== "success";
				return {
					...textToolResult(`${formatApplyPatchResult(result)}${warning}`, {
						...result,
						status,
					}),
					...(isError ? { isError: true } : {}),
				} satisfies AgentToolResult<ApplyPatchToolDetails>;
			} catch (error) {
				const message = errorMessage(error);
				throw new Error(`apply_patch failed: ${message}`);
			} finally {
				// The result below is the only authority for the finished call, so the window closes
				// here: a repaint after it is built would rewrite a settled body.
				repaint.dispose();
			}
		},
	};
}

export function registerApplyPatchTool(pi: ExtensionAPI): ToolDefinition {
	const tool = {
		...createApplyPatchTool(),
		...createOptionalToolRenderers(
			pi,
			"apply_patch",
			createToolPresentationRenderers(pi, "apply_patch", applyPatchPresentation),
		),
		defaultActive: false,
	};
	pi.registerTool(tool);
	return tool as ToolDefinition;
}
