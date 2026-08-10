import { performance } from "node:perf_hooks";
import type {
	AgentToolResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import {
	type ApplyPatchInWorkspaceResult,
	type ApplyPatchProgress,
	type ApplyPatchRejection,
	applyPatchThroughCoordinator,
} from "./apply-patch/index.js";
import { parseV4aPatch } from "./apply-patch/parser.js";
import { formatApplyPatchFooter, renderApplyPatchResult } from "./apply-patch/renderer.js";
import { withToolFrame } from "./pretty/frame.js";
import { ToolTraceController } from "./pretty/trace.js";

const OWNER = "@hheei/pi-ext-tools";
const OUTPUT_PREFIX = "output:" + "//";
const MAX_CANDIDATES = 6;

export const APPLY_PATCH_PARAMETERS = Type.Object(
	{
		patch: Type.String({
			description:
				"V4A patch text. `*** Begin Patch` first, `*** End Patch` last; never repeat either marker. Use Add File, Update File, Delete File, and optional Move to sections.",
		}),
	},
	{ additionalProperties: false },
);

type ApplyPatchParameters = Static<typeof APPLY_PATCH_PARAMETERS>;
export type ApplyPatchStatus = "success" | "partial" | "failed";

export interface ApplyPatchToolDetails extends ApplyPatchInWorkspaceResult {
	readonly status: ApplyPatchStatus;
	readonly progress?: ApplyPatchProgress;
	readonly durationMs?: number;
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

export function modifiesOutputPath(patch: string): boolean {
	return parseV4aPatch(patch).operations.some(
		(operation) =>
			operation.path.startsWith(OUTPUT_PREFIX) ||
			("moveTo" in operation && operation.moveTo?.startsWith(OUTPUT_PREFIX) === true),
	);
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

function rejectedOperationCount(result: ApplyPatchInWorkspaceResult): number {
	return new Set(result.rejected.flatMap((rejection) => rejection.operationIndices)).size;
}

function statusFor(result: ApplyPatchInWorkspaceResult): ApplyPatchStatus {
	return rejectedOperationCount(result) === 0
		? "success"
		: result.changedPaths.length === 0
			? "failed"
			: "partial";
}

function operationText(index: number): string {
	return `operation ${index + 1}`;
}

function rejectionLines(rejection: ApplyPatchRejection): readonly string[] {
	const operation = rejection.operationIndices.map(operationText).join(", ");
	const path = rejection.paths.join(", ");
	const prefix = `- ${operation}, ${path}`;
	if (rejection.diagnostics.length === 0) return [`${prefix}: ${rejection.error}`];
	return rejection.diagnostics.flatMap((diagnostic) => {
		switch (diagnostic.kind) {
			case "context_not_found":
				return [`${prefix}, hunk ${diagnostic.hunkIndex}: context not found`];
			case "ambiguous_exact":
				return [
					`${prefix}, hunk ${diagnostic.hunkIndex}: exact context is ambiguous at lines ${diagnostic.candidateStartLines
						.slice(0, MAX_CANDIDATES)
						.join(", ")} (${diagnostic.candidateStartLines.length} candidates)`,
				];
			case "ambiguous_fuzzy":
				return [
					`${prefix}, hunk ${diagnostic.hunkIndex}: fuzzy context is ambiguous at ${diagnostic.candidates
						.slice(0, MAX_CANDIDATES)
						.map(
							(candidate) =>
								`lines ${candidate.startLine}-${candidate.startLine + candidate.length - 1}`,
						)
						.join(", ")} (${diagnostic.candidates.length} candidates)`,
				];
			case "fuzzy_below_threshold": {
				const score = diagnostic.best.score.toFixed(2);
				const threshold = diagnostic.threshold.toFixed(2);
				return diagnostic.best.score > diagnostic.threshold * 0.7
					? [
							`${prefix}, hunk ${diagnostic.hunkIndex}: best fuzzy candidate lines ${diagnostic.best.startLine}-${diagnostic.best.startLine + diagnostic.best.length - 1}, score ${score} < required ${threshold}`,
						]
					: [
							`${prefix}, hunk ${diagnostic.hunkIndex}: best fuzzy score ${score} < required ${threshold}`,
						];
			}
			default:
				throw new Error(`Unknown patch diagnostic: ${String(diagnostic)}`);
		}
	});
}

function recoveryLines(result: ApplyPatchInWorkspaceResult): readonly string[] {
	if (result.rejected.length === 0) return [];
	const paths = [...new Set(result.rejected.flatMap((rejection) => rejection.paths))];
	const operations = [
		...new Set(result.rejected.flatMap((rejection) => rejection.operationIndices)),
	];
	const scope = operations.map(operationText).join(", ");
	return [
		`Recovery: read ${paths.join(", ")}, then retry only ${scope}.`,
		...(result.applied.length === 0 ? [] : ["Do not retry applied operations."]),
	];
}

export function formatApplyPatchResult(result: ApplyPatchInWorkspaceResult): string {
	const status = statusFor(result);
	const applied = result.applied.flatMap((operation) =>
		operation.paths.map((path) => `- ${path}: ${operation.kind}`),
	);
	const fuzzy = result.applied.flatMap((operation) =>
		operation.outcomes
			.filter((outcome) => outcome.match === "fuzzy")
			.map(
				(outcome) =>
					`- ${operation.paths.at(-1) ?? "unknown"}, ${operationText(operation.operationIndex)}, hunk ${outcome.hunkIndex}: lines ${outcome.startLine}-${outcome.startLine + outcome.length - 1}, similarity ${outcome.score?.toFixed(2) ?? "unknown"}`,
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
			: ["Rejected:", ...result.rejected.flatMap(rejectionLines), ...recoveryLines(result)]),
	].join("\n");
}

function progressDetails(progress: ApplyPatchProgress, durationMs: number): ApplyPatchToolDetails {
	return {
		changedPaths: [],
		addedLines: progress.addedLines,
		removedLines: progress.removedLines,
		operations: progress.operations,
		operationCount: progress.operations.length,
		exactUpdateCount: 0,
		fuzzyUpdateCount: 0,
		applied: [],
		rejected: [],
		status: "success",
		progress,
		durationMs,
	};
}

export function applyPatchHeader(
	latest: AgentToolResult<ApplyPatchToolDetails> | undefined,
): string | undefined {
	const details = latest?.details;
	if (!isApplyPatchToolDetails(details)) return undefined;
	const progress = details.progress;
	const files = progress?.files ?? details.changedPaths.length;
	return `${files} files · +${details.addedLines} -${details.removedLines} lines`;
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
		renderResult: (result, options, theme) =>
			renderApplyPatchResult(result, options.expanded, theme),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const startedAt = performance.now();
			const { patch } = parseApplyPatchParameters(params);
			if (modifiesOutputPath(patch)) throw new Error("apply_patch cannot modify output URLs");
			try {
				const result = await applyPatchThroughCoordinator({
					workspaceRoot: ctx.cwd,
					patch,
					...(signal === undefined ? {} : { signal }),
					onProgress: (progress) =>
						onUpdate?.({
							content: [],
							details: progressDetails(progress, Math.round(performance.now() - startedAt)),
						}),
				});
				return {
					content: [{ type: "text", text: formatApplyPatchResult(result) }],
					details: {
						...result,
						status: statusFor(result),
						durationMs: Math.round(performance.now() - startedAt),
					},
				} satisfies AgentToolResult<ApplyPatchToolDetails>;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`apply_patch failed: ${message}`);
			}
		},
	};
}

export function registerApplyPatchTool(pi: ExtensionAPI, trace = new ToolTraceController()): void {
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
		withToolFrame(
			createApplyPatchTool(),
			trace,
			(result, completion) =>
				isApplyPatchToolDetails(result.details)
					? formatApplyPatchFooter(result, completion)
					: undefined,
			(result) => isApplyPatchToolDetails(result.details) && result.details.status !== "success",
			(_args, latest) => applyPatchHeader(latest),
		),
	);
}
