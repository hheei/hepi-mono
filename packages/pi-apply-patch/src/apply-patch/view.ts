import type { Theme } from "@earendil-works/pi-coding-agent";
import { isRecord } from "@hheei/pi-ext-core";
import { diffArrays } from "diff";
import { MUTATION_GLYPH, MUTATION_TONE } from "./glyph.js";
import type {
	ApplyPatchHunkSnapshot,
	ApplyPatchOperationProgress,
	ApplyPatchOperationStatus,
	ApplyPatchRejection,
	RejectedPatchHunk,
} from "./outcome.js";

/**
 * Display-side reading of the persisted `apply_patch` details. The details are the contract; a
 * session written by an older build reaches this module as untrusted JSON, so every field is
 * narrowed once here and dropped when it does not match.
 */
export interface ApplyPatchResultFacts {
	readonly status: "success" | "partial" | "failed";
	readonly operations: readonly ApplyPatchOperationProgress[];
	readonly snapshots: readonly ApplyPatchHunkSnapshot[];
	readonly rejected: readonly ApplyPatchRejection[];
	readonly unconfirmed: readonly ApplyPatchRejection[];
	readonly notApplied: readonly ApplyPatchRejection[];
	readonly addedLines: number;
	readonly removedLines: number;
	readonly changedPaths: readonly string[];
}

const OPERATION_STATUSES: ReadonlySet<string> = new Set<ApplyPatchOperationStatus>([
	"pending",
	"applied",
	"partial",
	"fuzzy",
	"unconfirmed",
	"not_applied",
	"rejected",
]);

function isPatchStatus(value: unknown): value is ApplyPatchResultFacts["status"] {
	return value === "success" || value === "partial" || value === "failed";
}

function numberField(source: Record<string, unknown>, key: string): number | undefined {
	const value = source[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	return typeof value === "string" ? value : undefined;
}

function stringList(value: unknown): readonly string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function operationView(value: unknown): ApplyPatchOperationProgress | undefined {
	if (!isRecord(value)) return undefined;
	const path = stringField(value, "path");
	const kind = value.kind;
	const status = value.status;
	if (path === undefined) return undefined;
	if (kind !== "add" && kind !== "delete" && kind !== "update") return undefined;
	if (typeof status !== "string" || !OPERATION_STATUSES.has(status)) return undefined;
	const appliedHunks = numberField(value, "appliedHunks");
	const totalHunks = numberField(value, "totalHunks");
	const partialReason = stringField(value, "partialReason");
	return {
		operationIndex: numberField(value, "operationIndex") ?? 0,
		kind,
		path,
		addedLines: numberField(value, "addedLines") ?? 0,
		removedLines: numberField(value, "removedLines") ?? 0,
		status: status as ApplyPatchOperationStatus,
		...(appliedHunks === undefined ? {} : { appliedHunks }),
		...(totalHunks === undefined ? {} : { totalHunks }),
		...(partialReason === undefined ? {} : { partialReason }),
	};
}

function snapshotView(value: unknown): ApplyPatchHunkSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	const path = stringField(value, "path");
	if (path === undefined) return undefined;
	const before = value.before;
	const after = value.after;
	if (!Array.isArray(before) || !Array.isArray(after)) return undefined;
	const startLine = numberField(value, "startLine");
	return {
		path,
		hunkIndex: numberField(value, "hunkIndex") ?? 0,
		startLine: startLine !== undefined && startLine > 0 ? startLine : 1,
		afterStartLine: numberField(value, "afterStartLine") ?? startLine ?? 1,
		before: before.filter((line): line is string => typeof line === "string"),
		after: after.filter((line): line is string => typeof line === "string"),
	};
}

function diagnosticView(value: unknown): RejectedPatchHunk | undefined {
	if (!isRecord(value)) return undefined;
	const hunkIndex = numberField(value, "hunkIndex");
	if (hunkIndex === undefined) return undefined;
	switch (value.kind) {
		case "context_not_found": {
			const hint = stringField(value, "hint");
			return { kind: "context_not_found", hunkIndex, ...(hint === undefined ? {} : { hint }) };
		}
		case "ambiguous_exact":
			return {
				kind: "ambiguous_exact",
				hunkIndex,
				candidateStartLines: Array.isArray(value.candidateStartLines)
					? value.candidateStartLines.filter((line): line is number => typeof line === "number")
					: [],
			};
		default:
			return undefined;
	}
}

function rejectionView(value: unknown): ApplyPatchRejection | undefined {
	if (!isRecord(value)) return undefined;
	const error = stringField(value, "error");
	if (error === undefined) return undefined;
	const operationIndices = Array.isArray(value.operationIndices)
		? value.operationIndices.filter((index): index is number => typeof index === "number")
		: [];
	return {
		operationIndices,
		paths: stringList(value.paths),
		error,
		diagnostics: Array.isArray(value.diagnostics)
			? value.diagnostics
					.map(diagnosticView)
					.filter((diagnostic): diagnostic is RejectedPatchHunk => diagnostic !== undefined)
			: [],
	};
}

function rejectionList(value: unknown): readonly ApplyPatchRejection[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(rejectionView)
		.filter((rejection): rejection is ApplyPatchRejection => rejection !== undefined);
}

/** Applied-operation snapshots, in the executor's operation order. */
function snapshotList(value: unknown): readonly ApplyPatchHunkSnapshot[] {
	if (!Array.isArray(value)) return [];
	const snapshots: ApplyPatchHunkSnapshot[] = [];
	for (const operation of value) {
		if (!isRecord(operation) || !Array.isArray(operation.snapshots)) continue;
		for (const snapshot of operation.snapshots) {
			const view = snapshotView(snapshot);
			if (view !== undefined) snapshots.push(view);
		}
	}
	return snapshots;
}

/** Reads only the persisted `apply_patch` details; other shapes return undefined. */
export function applyPatchResultFacts(details: unknown): ApplyPatchResultFacts | undefined {
	if (!isRecord(details) || !isPatchStatus(details.status)) return undefined;
	return {
		status: details.status,
		operations: Array.isArray(details.operations)
			? details.operations
					.map(operationView)
					.filter((operation): operation is ApplyPatchOperationProgress => operation !== undefined)
			: [],
		snapshots: snapshotList(details.applied),
		rejected: rejectionList(details.rejected),
		unconfirmed: rejectionList(details.unconfirmed),
		notApplied: rejectionList(details.notApplied),
		addedLines: numberField(details, "addedLines") ?? 0,
		removedLines: numberField(details, "removedLines") ?? 0,
		changedPaths: stringList(details.changedPaths),
	};
}

/** How one mutation outcome is drawn. One outcome never draws two symbols across the tools. */
export function applyPatchGlyph(status: string, theme: Theme): string {
	const glyph = MUTATION_GLYPH[status as ApplyPatchOperationStatus] ?? "✗";
	const tone = MUTATION_TONE[status as ApplyPatchOperationStatus] ?? "error";
	return theme.fg(tone, glyph);
}

/**
 * Distinct paths a live frame still has in play: a pending row previews the write it is about to
 * make, and a row that certainly wrote nothing is not counted. The finished result counts
 * `changedPaths` instead, so a preview never claims a path was changed.
 */
export function applyPatchFilesInPlay(operations: readonly ApplyPatchOperationProgress[]): number {
	return new Set(
		operations
			.filter((operation) => operation.status !== "rejected" && operation.status !== "not_applied")
			.map((operation) => operation.path),
	).size;
}

/** The header summary every apply_patch row shares, including nested calls. */
export function applyPatchSummary(files: number, added: number, removed: number): string {
	return `modify ${String(files)}${files === 1 ? " file" : " files"} (+${String(added)} -${String(removed)})`;
}

/** One operation row: glyph, verb, path, delta, fuzzy marker, hunk summary. */
export function formatApplyPatchOperationRow(
	operation: ApplyPatchOperationProgress,
	theme: Theme,
): string {
	const glyph = applyPatchGlyph(operation.status, theme);
	const kind =
		operation.kind === "add" ? "create" : operation.kind === "delete" ? "delete" : "modify";
	const path = operation.path;
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
					`(${String(operation.appliedHunks)}/${String(operation.totalHunks)} hunks applied${
						operation.partialReason === undefined ? "" : `; ${operation.partialReason}`
					})`,
				)}`
			: "";
	return `${glyph} ${theme.fg("toolTitle", kind)} ${path}${delta}${score}${hunks}`.trimEnd();
}

function diagnosticText(diagnostic: RejectedPatchHunk): string {
	switch (diagnostic.kind) {
		case "context_not_found":
			return diagnostic.hint === undefined
				? "context not found"
				: `context not found (${diagnostic.hint})`;
		case "ambiguous_exact":
			return `exact context is ambiguous at lines ${diagnostic.candidateStartLines.join(", ")}`;
		default:
			return "context not applied";
	}
}

/** Rejected, unconfirmed and not-applied rows, each carrying its own outcome glyph. */
export function formatApplyPatchRejectionRows(
	rejections: readonly ApplyPatchRejection[],
	status: ApplyPatchOperationStatus,
	theme: Theme,
): readonly string[] {
	const rows: string[] = [];
	for (const rejection of rejections) {
		const prefix = `${applyPatchGlyph(status, theme)} ${rejection.paths[0] ?? "<unknown>"} · `;
		if (rejection.diagnostics.length === 0) {
			rows.push(`${prefix}${rejection.error}`);
			continue;
		}
		for (const diagnostic of rejection.diagnostics) {
			rows.push(`${prefix}${diagnosticText(diagnostic)}`);
		}
	}
	return rows;
}

/**
 * Rows of one applied snapshot: the single-column sign, absolute line number and text the shared
 * diff body draws. Context rows come from the snapshot's own before/after lines, so no file context
 * outside the recorded window is invented.
 */
export function formatApplyPatchSnapshotRows(
	snapshot: ApplyPatchHunkSnapshot,
	theme: Theme,
): readonly string[] {
	const lines = snapshotLines(snapshot);
	if (lines.length === 0) return [];
	const numberWidth = Math.max(2, ...lines.map((line) => String(line.line).length));
	const rows = lines.map(
		(line) =>
			`${theme.fg(line.tone, `${line.sign}${String(line.line).padStart(numberWidth)} ${line.text}`)}`,
	);
	return rows;
}

interface SnapshotRow {
	readonly sign: "+" | "-" | " ";
	readonly tone: "success" | "error" | "dim";
	readonly line: number;
	readonly text: string;
}

/** Line LCS of one stored before/after window, numbered from the snapshot's own start lines. */
function snapshotLines(snapshot: ApplyPatchHunkSnapshot): readonly SnapshotRow[] {
	if (snapshot.before.length === 0 && snapshot.after.length === 0) return [];
	const rows: SnapshotRow[] = [];
	let oldLine = snapshot.startLine;
	let newLine = snapshot.afterStartLine;
	for (const part of diffArrays([...snapshot.before], [...snapshot.after])) {
		for (const text of part.value) {
			if (part.added === true) {
				rows.push({ sign: "+", tone: "success", line: newLine, text });
				newLine += 1;
			} else if (part.removed === true) {
				rows.push({ sign: "-", tone: "error", line: oldLine, text });
				oldLine += 1;
			} else {
				rows.push({ sign: " ", tone: "dim", line: newLine, text });
				oldLine += 1;
				newLine += 1;
			}
		}
	}
	return rows;
}
