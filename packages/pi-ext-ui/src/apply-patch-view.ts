import type { Theme } from "@earendil-works/pi-coding-agent";

import { applyPatchGlyph } from "./apply-patch-glyph.js";

/**
 * Display-side view of pi-ext-tools' persisted `ApplyPatchToolDetails`.
 * The details are the contract; every field is read defensively at this
 * untrusted boundary and dropped when it does not match the contract.
 */
export interface ApplyPatchOperationView {
	readonly operationIndex: number;
	readonly kind: "add" | "delete" | "update";
	readonly path: string;
	readonly addedLines: number;
	readonly removedLines: number;
	readonly status: string;
	readonly appliedHunks: number | undefined;
	readonly totalHunks: number | undefined;
	readonly partialReason: string | undefined;
}

export interface ApplyPatchSnapshotView {
	readonly path: string;
	readonly startLine: number;
	readonly before: readonly string[];
	readonly after: readonly string[];
}

export interface ApplyPatchRejectionView {
	readonly paths: readonly string[];
	readonly error: string;
	readonly diagnostics: readonly { readonly text: string }[];
}

export interface ApplyPatchFacts {
	readonly status: "success" | "partial" | "failed";
	readonly operations: readonly ApplyPatchOperationView[];
	readonly snapshots: readonly ApplyPatchSnapshotView[];
	readonly rejected: readonly ApplyPatchRejectionView[];
	readonly unconfirmed: readonly ApplyPatchRejectionView[];
	readonly notApplied: readonly ApplyPatchRejectionView[];
	readonly addedLines: number;
	readonly removedLines: number;
	readonly changedPaths: readonly string[];
	readonly target: string | undefined;
	readonly inProgress: boolean;
}

const PATCH_STATUSES: readonly string[] = ["success", "partial", "failed"];

function isPatchStatus(value: string): value is "success" | "partial" | "failed" {
	return PATCH_STATUSES.includes(value);
}
const OPERATION_STATUSES = new Set([
	"pending",
	"applied",
	"partial",
	"fuzzy",
	"unconfirmed",
	"not_applied",
	"rejected",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operationView(value: Record<string, unknown>): ApplyPatchOperationView | undefined {
	const path = typeof value.path === "string" ? value.path : undefined;
	if (path === undefined) return undefined;
	const kind =
		value.kind === "add" || value.kind === "delete" || value.kind === "update"
			? value.kind
			: undefined;
	if (kind === undefined) return undefined;
	const status =
		typeof value.status === "string" && OPERATION_STATUSES.has(value.status)
			? value.status
			: undefined;
	if (status === undefined) return undefined;
	return {
		operationIndex: typeof value.operationIndex === "number" ? value.operationIndex : 0,
		kind,
		path,
		addedLines: typeof value.addedLines === "number" ? value.addedLines : 0,
		removedLines: typeof value.removedLines === "number" ? value.removedLines : 0,
		status,
		appliedHunks: typeof value.appliedHunks === "number" ? value.appliedHunks : undefined,
		totalHunks: typeof value.totalHunks === "number" ? value.totalHunks : undefined,
		partialReason: typeof value.partialReason === "string" ? value.partialReason : undefined,
	};
}

function snapshotView(value: Record<string, unknown>): ApplyPatchSnapshotView | undefined {
	const path = typeof value.path === "string" ? value.path : undefined;
	if (path === undefined) return undefined;
	const before = Array.isArray(value.before)
		? value.before.filter((line): line is string => typeof line === "string")
		: undefined;
	const after = Array.isArray(value.after)
		? value.after.filter((line): line is string => typeof line === "string")
		: undefined;
	if (before === undefined || after === undefined) return undefined;
	return {
		path,
		startLine: typeof value.startLine === "number" && value.startLine > 0 ? value.startLine : 1,
		before,
		after,
	};
}

function rejectionView(value: Record<string, unknown>): ApplyPatchRejectionView | undefined {
	const error = typeof value.error === "string" ? value.error : undefined;
	if (error === undefined) return undefined;
	const paths = Array.isArray(value.paths)
		? value.paths.filter((path): path is string => typeof path === "string")
		: [];
	const diagnostics = Array.isArray(value.diagnostics)
		? value.diagnostics
				.filter(isRecord)
				.map((diagnostic) => {
					if (diagnostic.kind === "context_not_found") {
						return typeof diagnostic.hint === "string"
							? `context not found (${diagnostic.hint})`
							: "context not found";
					}
					if (diagnostic.kind === "ambiguous_exact") {
						const candidates = Array.isArray(diagnostic.candidateStartLines)
							? diagnostic.candidateStartLines.filter(
									(line): line is number => typeof line === "number",
								)
							: [];
						return `exact context is ambiguous at lines ${candidates.join(", ")}`;
					}
					return undefined;
				})
				.filter((text): text is string => text !== undefined)
				.map((text) => ({ text }))
		: [];
	return { paths, error, diagnostics };
}

function rejectionList(value: unknown): readonly ApplyPatchRejectionView[] {
	if (!Array.isArray(value)) return [];
	const views: ApplyPatchRejectionView[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const view = rejectionView(entry);
		if (view !== undefined) views.push(view);
	}
	return views;
}

/** Reads only the persisted apply_patch details; other shapes return undefined. */
export function applyPatchFacts(details: unknown): ApplyPatchFacts | undefined {
	if (!isRecord(details)) return undefined;
	if (typeof details.status !== "string" || !isPatchStatus(details.status)) return undefined;
	const status = details.status;
	const operations = Array.isArray(details.operations)
		? details.operations
				.filter(isRecord)
				.map(operationView)
				.filter((operation): operation is ApplyPatchOperationView => operation !== undefined)
		: [];
	// Older results carry applied/rejected lists instead of operations; the operation
	// rows are rebuilt from them without hunk counts.
	const applied = Array.isArray(details.applied) ? details.applied.filter(isRecord) : [];
	const rejected = rejectionList(details.rejected);
	if (operations.length === 0) {
		for (const operation of applied) {
			const path =
				typeof operation.paths === "object" &&
				operation.paths !== null &&
				Array.isArray(operation.paths) &&
				typeof operation.paths[0] === "string"
					? operation.paths[0]
					: undefined;
			if (path === undefined) continue;
			const view = operationView({
				operationIndex: operation.operationIndex,
				kind: operation.kind,
				path,
				addedLines: 0,
				removedLines: 0,
				status: "applied",
			});
			if (view !== undefined) operations.push(view);
		}
		for (const [index, rejection] of rejected.entries()) {
			const view = operationView({
				operationIndex: index,
				kind: "update",
				path: rejection.paths[0] ?? "<unknown>",
				addedLines: 0,
				removedLines: 0,
				status: "rejected",
			});
			if (view !== undefined) operations.push(view);
		}
	}
	const snapshots = Array.isArray(details.applied)
		? details.applied.filter(isRecord).flatMap((operation) =>
				Array.isArray(operation.snapshots)
					? operation.snapshots
							.filter(isRecord)
							.map(snapshotView)
							.filter((snapshot): snapshot is ApplyPatchSnapshotView => snapshot !== undefined)
					: [],
			)
		: [];
	return {
		status,
		operations,
		snapshots,
		rejected,
		unconfirmed: rejectionList(details.unconfirmed),
		notApplied: rejectionList(details.notApplied),
		addedLines: typeof details.addedLines === "number" ? details.addedLines : 0,
		removedLines: typeof details.removedLines === "number" ? details.removedLines : 0,
		changedPaths: Array.isArray(details.changedPaths)
			? details.changedPaths.filter((path): path is string => typeof path === "string")
			: [],
		target:
			typeof details.target === "string" && details.target !== "local" ? details.target : undefined,
		inProgress: isRecord(details.progress),
	};
}

/** One operation row: glyph, verb, path, delta, fuzzy marker, hunk summary. */
export function formatApplyPatchOperationRow(
	operation: ApplyPatchOperationView,
	theme: Theme,
	host: string | undefined,
): string {
	const glyph = applyPatchGlyph(operation.status, theme);
	const kind =
		operation.kind === "add" ? "create" : operation.kind === "delete" ? "delete" : "modify";
	const path =
		host === undefined ? operation.path : `${theme.fg("warning", `${host}:`)}${operation.path}`;
	const deltaParts: string[] = [];
	if (operation.addedLines > 0)
		deltaParts.push(theme.fg("success", `+${String(operation.addedLines)}`));
	if (operation.removedLines > 0)
		deltaParts.push(theme.fg("error", `-${String(operation.removedLines)}`));
	const delta = deltaParts.length > 0 ? ` (${deltaParts.join(" ")})` : "";
	const score = operation.status === "fuzzy" ? ` ${theme.fg("dim", "fuzzy")}` : "";
	const hunks =
		operation.status === "partial" &&
		operation.appliedHunks !== undefined &&
		operation.totalHunks !== undefined
			? ` ${theme.fg(
					"dim",
					`(${String(operation.appliedHunks)}/${String(operation.totalHunks)} hunks applied${operation.partialReason === undefined ? "" : `; ${operation.partialReason}`})`,
				)}`
			: "";
	return `${glyph} ${theme.fg("toolTitle", kind)} ${path}${delta}${score}${hunks}`.trimEnd();
}
