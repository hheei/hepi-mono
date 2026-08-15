import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";

import type { ApplyPatchToolDetails } from "../apply-patch-tool.js";
import { MAX_RENDER_LINES } from "../pretty/config.js";
import { parseDiff } from "../pretty/diff.js";
import { renderSplit, resolveDiffColors } from "../pretty/diff-render.js";
import { lang } from "../pretty/lang.js";
import { LinesBody } from "../pretty/lines-body.js";
import type {
	ApplyPatchHunkSnapshot,
	ApplyPatchOperationProgress,
	MpatchHunkOutcome,
} from "./outcome.js";
import { previewV4aPatchPrefix } from "./parser.js";

function duration(durationMs: number | undefined): string {
	return `${((durationMs ?? 0) / 1_000).toFixed(2)}s`;
}

function delta(operation: ApplyPatchOperationProgress, theme: Theme): string {
	return [
		operation.addedLines ? theme.fg("success", `+${operation.addedLines}`) : undefined,
		operation.removedLines ? theme.fg("error", `-${operation.removedLines}`) : undefined,
	]
		.filter((value): value is string => value !== undefined)
		.join(" ");
}

function row(operation: ApplyPatchOperationProgress, theme: Theme): string {
	const glyph =
		operation.status === "pending"
			? theme.fg("dim", "○")
			: operation.status === "applied"
				? theme.fg("success", "✓")
				: operation.status === "partial"
					? theme.fg("warning", "!")
					: operation.status === "fuzzy"
						? theme.fg("warning", "!")
						: theme.fg("error", "✗");
	const score =
		operation.status === "fuzzy" && operation.score !== undefined
			? ` ${theme.fg("dim", `(${operation.score.toFixed(2)})`)}`
			: "";
	const hunkSummary =
		operation.status === "partial" &&
		operation.appliedHunks !== undefined &&
		operation.totalHunks !== undefined
			? ` ${theme.fg("dim", `(${operation.appliedHunks}/${operation.totalHunks} hunks applied${operation.partialReason === undefined ? "" : `; ${operation.partialReason}`})`)} `
			: " ";
	const kind =
		operation.kind === "add" ? "create" : operation.kind === "delete" ? "delete" : "modify";
	return `${glyph} ${theme.fg("toolTitle", kind)} ${operation.path} ${delta(operation, theme)}${score}${hunkSummary}`.trimEnd();
}

function operations(details: ApplyPatchToolDetails): readonly ApplyPatchOperationProgress[] {
	if (details.operations !== undefined) return details.operations;
	return [
		...details.applied.map((operation) => ({
			operationIndex: operation.operationIndex,
			kind: operation.kind,
			path: operation.paths[0] ?? "<unknown>",
			addedLines: 0,
			removedLines: 0,
			status: (operation.outcomes.some(
				(outcome) => outcome.kind === "applied" && outcome.match === "fuzzy",
			)
				? "fuzzy"
				: "applied") as ApplyPatchOperationProgress["status"],
		})),
		...details.rejected.map((rejection, index) => ({
			operationIndex: rejection.operationIndices[0] ?? index,
			kind: "update" as const,
			path: rejection.paths[0] ?? "<unknown>",
			addedLines: 0,
			removedLines: 0,
			status: "rejected" as const,
		})),
	];
}

function totalDelta(details: ApplyPatchToolDetails): string {
	return (
		[
			details.addedLines === 0 ? undefined : `+${details.addedLines}`,
			details.removedLines === 0 ? undefined : `-${details.removedLines}`,
		]
			.filter((value): value is string => value !== undefined)
			.join(" ") || "0"
	);
}

function footer(details: ApplyPatchToolDetails): string {
	const count = (kind: ApplyPatchOperationProgress["kind"]): number =>
		operations(details).filter(
			(operation) => operation.kind === kind && operation.status !== "pending",
		).length;
	return [
		count("add") > 0 ? `created ${count("add")}` : undefined,
		count("delete") > 0 ? `deleted ${count("delete")}` : undefined,
		count("update") > 0 ? `modified ${count("update")}` : undefined,
		details.progress === undefined ? `${totalDelta(details)} lines` : undefined,
		duration(details.durationMs),
	]
		.filter((value): value is string => value !== undefined)
		.join(" · ");
}

export function formatApplyPatchFooter(
	value: { readonly details?: unknown } | ApplyPatchToolDetails,
	completion?: { readonly durationMs?: number } | number,
): string | undefined {
	const details = detailsFor(value);
	if (details === undefined) return undefined;
	const durationMs = typeof completion === "number" ? completion : completion?.durationMs;
	return footer({
		...details,
		...(details.durationMs === undefined && durationMs !== undefined ? { durationMs } : {}),
	});
}

function snapshotLines(snapshot: ApplyPatchHunkSnapshot, theme: Theme, width: number): string[] {
	if (snapshot.before.length === 0 && snapshot.after.length === 0) return [];
	const parsed = parseDiff(
		snapshot.before.join("\n"),
		snapshot.after.join("\n"),
		Math.max(snapshot.before.length, snapshot.after.length, 1),
		snapshot.startLine,
	);
	const text = renderSplit(
		parsed,
		lang(snapshot.path),
		MAX_RENDER_LINES,
		resolveDiffColors(theme),
		width,
	);
	return text === "" ? [] : text.split("\n");
}

function diagnosticText(
	diagnostic: Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>,
): string {
	switch (diagnostic.kind) {
		case "context_not_found":
			return "context not found";
		case "ambiguous_exact":
			return `exact context is ambiguous at lines ${diagnostic.candidateStartLines.join(", ")}`;
		case "ambiguous_fuzzy":
			return `fuzzy context is ambiguous at ${diagnostic.candidates
				.map(
					(candidate) =>
						`lines ${candidate.startLine}-${candidate.startLine + candidate.length - 1}`,
				)
				.join(", ")}`;
		case "fuzzy_below_threshold":
			return `best fuzzy score ${diagnostic.best.score.toFixed(2)} < required ${diagnostic.threshold.toFixed(2)}`;
	}
}

export function renderApplyPatchCall(
	args: unknown,
	theme: Theme,
	context: { readonly argsComplete?: boolean } = {},
): Component {
	const patch =
		typeof args === "object" && args !== null && "patch" in args && typeof args.patch === "string"
			? args.patch
			: "";
	const operations = previewV4aPatchPrefix(patch, context.argsComplete === true);
	if (operations.length === 0) return new Container();
	const body = new Container();
	for (const [index, operation] of operations.entries()) {
		body.addChild(
			new Text(
				row(
					{
						operationIndex: index,
						kind: operation.kind,
						path: operation.path,
						addedLines: operation.addedLines,
						removedLines: operation.removedLines,
						status: "pending",
					},
					theme,
				),
				0,
				0,
			),
		);
	}
	return body;
}

export function renderApplyPatchResult(
	value: { readonly details?: unknown } | ApplyPatchToolDetails,
	expanded: boolean,
	theme: Theme,
): Component {
	const details = detailsFor(value);
	if (details === undefined) return new Text("", 0, 0);
	const operationRows = operations(details);
	if (!expanded) {
		const body = new Container();
		for (const operation of operationRows) body.addChild(new Text(row(operation, theme), 0, 0));
		return body;
	}
	return new LinesBody((width) => {
		const lines = operationRows.map((operation) => row(operation, theme));
		for (const applied of details.applied) {
			for (const snapshot of applied.snapshots) {
				lines.push(...snapshotLines(snapshot, theme, width));
			}
		}
		for (const rejected of details.rejected) {
			lines.push(theme.fg("error", rejected.error));
			for (const diagnostic of rejected.diagnostics) {
				lines.push(
					theme.fg(
						"error",
						`✗ ${rejected.paths[0] ?? "<unknown>"} · hunk ${diagnostic.hunkIndex} · ${diagnosticText(diagnostic)}`,
					),
				);
			}
		}
		return lines;
	});
}

function detailsFor(
	value: { readonly details?: unknown } | ApplyPatchToolDetails,
): ApplyPatchToolDetails | undefined {
	const candidate = "details" in value ? value.details : value;
	return isApplyPatchToolDetails(candidate) ? candidate : undefined;
}

function isApplyPatchToolDetails(value: unknown): value is ApplyPatchToolDetails {
	return typeof value === "object" && value !== null;
}
