import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	agentResultText,
	isRecord,
	type ToolPresentation,
	type ToolPresentationContext,
	type ToolPresentationProvider,
	type ToolPresentationSection,
	type ToolPresentationStatus,
} from "@hheei/pi-ext-core";
import type { ApplyPatchOperationProgress } from "./outcome.js";
import { createV4aPreviewCursor, previewV4aPatchPrefix, type V4aPreviewCursor } from "./parser.js";
import {
	applyPatchFilesInPlay,
	applyPatchResultFacts,
	applyPatchSummary,
	formatApplyPatchOperationRow,
	formatApplyPatchRejectionRows,
	formatApplyPatchSnapshotRows,
} from "./view.js";

/**
 * Preview cursors live in this module's own map, keyed by the row's shared render state: the cursor
 * is display-only progress, so it is never persisted and never read back from the session.
 */
const previewCursors = new WeakMap<object, V4aPreviewCursor>();

function patchArgument(args: unknown): string {
	return isRecord(args) && typeof args.patch === "string" ? args.patch : "";
}

function pendingOperation(operation: {
	readonly kind: "add" | "delete" | "update";
	readonly path: string;
	readonly addedLines: number;
	readonly removedLines: number;
}): ApplyPatchOperationProgress {
	return {
		operationIndex: 0,
		kind: operation.kind,
		path: operation.path,
		addedLines: operation.addedLines,
		removedLines: operation.removedLines,
		status: "pending",
	};
}

/**
 * Incremental preview of the operation headers recognized so far. The cursor belongs to the row, so
 * one streamed update only reads the lines the previous one had not seen.
 */
function previewOperations(
	patch: string,
	context: ToolPresentationContext,
): readonly ApplyPatchOperationProgress[] {
	const key =
		typeof context.state === "object" && context.state !== null ? context.state : undefined;
	const cursor =
		key === undefined
			? createV4aPreviewCursor()
			: (previewCursors.get(key) ?? createV4aPreviewCursor());
	const operations = previewV4aPatchPrefix(patch, context.argsComplete === true, cursor);
	if (key !== undefined) previewCursors.set(key, cursor);
	return operations.map(pendingOperation);
}

function operationRows(
	operations: readonly ApplyPatchOperationProgress[],
	theme: Parameters<ToolPresentationProvider>[2],
): readonly string[] {
	return operations.map((operation) => formatApplyPatchOperationRow(operation, theme));
}

/**
 * The call phase: operation headers recognized in the streamed patch as pending rows. The glyph only
 * marks a recognized header — it promises neither validation nor application.
 */
function callPresentation(
	args: unknown,
	theme: Parameters<ToolPresentationProvider>[2],
	context: ToolPresentationContext,
	isError: boolean,
): ToolPresentation {
	const patch = patchArgument(args);
	const operations = previewOperations(patch, context);
	const rows = operationRows(operations, theme);
	const files = new Set(operations.map((operation) => operation.path)).size;
	return {
		summary:
			files > 0
				? applyPatchSummary(
						files,
						operations.reduce((sum, operation) => sum + operation.addedLines, 0),
						operations.reduce((sum, operation) => sum + operation.removedLines, 0),
					)
				: "",
		status: isError ? "error" : "none",
		...(rows.length === 0 ? {} : { collapsedRows: rows }),
		...(rows.length === 0 ? {} : { sections: [{ railToken: "dim", content: rows }] }),
		...(patch === "" ? {} : { copy: { primary: patch } }),
	};
}

function resultStatus(
	facts: ReturnType<typeof applyPatchResultFacts>,
	isError: boolean,
	isPartial: boolean,
): ToolPresentationStatus {
	if (facts === undefined) return isError ? "error" : isPartial ? "running" : "ok";
	if (facts.status === "failed") return "error";
	if (facts.status === "partial") return "warn";
	// Live progress carries no verdict of its own, so a streamed success still reads as running
	// until the result replaces it.
	return isPartial ? "running" : "none";
}

/** Result sections: operation rows, one row block per applied snapshot, then the failure rows. */
function resultSections(
	facts: NonNullable<ReturnType<typeof applyPatchResultFacts>>,
	theme: Parameters<ToolPresentationProvider>[2],
): readonly ToolPresentationSection[] {
	const sections: ToolPresentationSection[] = [];
	const rows = operationRows(facts.operations, theme);
	if (rows.length > 0) sections.push({ railToken: "dim", content: rows });
	for (const snapshot of facts.snapshots) {
		const snapshotRows = formatApplyPatchSnapshotRows(snapshot, theme);
		if (snapshotRows.length > 0) sections.push({ railToken: "dim", content: snapshotRows });
	}
	const failures = [
		...formatApplyPatchRejectionRows(facts.rejected, "rejected", theme),
		...formatApplyPatchRejectionRows(facts.unconfirmed, "unconfirmed", theme),
		...formatApplyPatchRejectionRows(facts.notApplied, "not_applied", theme),
	];
	if (failures.length > 0) sections.push({ railToken: "error", content: failures });
	return sections;
}

function copySpec(
	patch: string,
	output: string,
): { readonly primary: string; readonly full?: string } | undefined {
	if (patch === "") return output === "" ? undefined : { primary: output };
	return output === "" ? { primary: patch } : { primary: patch, full: `${patch}\n---\n${output}` };
}

/**
 * The owned presentation of one apply_patch call or result. Facts come from the executor's
 * persisted details, never from the current workspace; a result without those details keeps its
 * model-visible text.
 */
export const applyPatchPresentation: ToolPresentationProvider = (args, result, theme, context) => {
	const isError = context.isError || result?.isError === true;
	if (result === undefined) return callPresentation(args, theme, context, isError);

	const output = stripTerminalSequences(agentResultText(result));
	const copy = copySpec(patchArgument(args), output);
	const facts = applyPatchResultFacts(result.details);
	if (facts === undefined) {
		return {
			summary: "",
			status: resultStatus(facts, isError, context.isPartial),
			replaceCallOnPartial: true,
			...(output === "" ? {} : { output }),
			...(output === ""
				? {}
				: { sections: [{ railToken: isError ? "error" : "dim", content: output.split("\n") }] }),
			...(copy === undefined ? {} : { copy }),
		};
	}
	const rows = operationRows(facts.operations, theme);
	// A live frame has no confirmed paths yet, so its file count comes from the rows it shows.
	const files = context.isPartial
		? applyPatchFilesInPlay(facts.operations)
		: new Set(facts.changedPaths).size;
	return {
		summary: applyPatchSummary(files, facts.addedLines, facts.removedLines),
		status: resultStatus(facts, isError, context.isPartial),
		replaceCallOnPartial: true,
		...(output === "" ? {} : { output }),
		...(rows.length === 0 ? {} : { collapsedRows: rows }),
		sections: resultSections(facts, theme),
		...(copy === undefined ? {} : { copy }),
	};
};
