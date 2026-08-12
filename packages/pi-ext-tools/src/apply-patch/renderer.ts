import { renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";

import type { ApplyPatchToolDetails } from "../apply-patch-tool.js";
import type { ApplyPatchOperationProgress, MpatchHunkOutcome } from "./outcome.js";

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
	const path = operation.kind === "add" ? operation.path : theme.fg("dim", operation.path);
	return `${glyph} ${theme.fg("success", kind)} ${path} ${delta(operation, theme)}${score}${hunkSummary}`.trimEnd();
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

class FullWidthRule implements Component {
	constructor(private readonly theme: Theme) {}

	render(width: number): string[] {
		return [this.theme.fg("borderMuted", "─".repeat(Math.max(1, width)))];
	}

	invalidate(): void {}
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

function snapshotDiff(path: string, before: readonly string[], after: readonly string[]): string {
	return `--- a/${path}\n+++ b/${path}\n@@ -1,${before.length} +1,${after.length} @@\n${before.map((line) => `-${line}`).join("\n")}\n${after.map((line) => `+${line}`).join("\n")}`;
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

export function renderApplyPatchResult(
	value: { readonly details?: unknown } | ApplyPatchToolDetails,
	expanded: boolean,
	theme: Theme,
): Component {
	const details = detailsFor(value);
	if (details === undefined) return new Text("", 0, 0);
	const container = new Container();
	for (const operation of operations(details))
		container.addChild(new Text(row(operation, theme), 0, 0));
	if (expanded) {
		for (const applied of details.applied)
			for (const snapshot of applied.snapshots)
				container.addChild(
					new Text(
						renderDiff(snapshotDiff(snapshot.path, snapshot.before, snapshot.after), {
							filePath: snapshot.path,
						}),
						0,
						0,
					),
				);
		for (const rejected of details.rejected) {
			container.addChild(new Text(theme.fg("error", rejected.error), 0, 0));
			for (const diagnostic of rejected.diagnostics)
				container.addChild(
					new Text(
						theme.fg(
							"error",
							`✗ ${rejected.paths[0] ?? "<unknown>"} · hunk ${diagnostic.hunkIndex} · ${diagnosticText(diagnostic)}`,
						),
						0,
						0,
					),
				);
		}
	}
	container.addChild(new FullWidthRule(theme));
	container.addChild(new Text(theme.fg("dim", footer(details)), 0, 0));
	return container;
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
