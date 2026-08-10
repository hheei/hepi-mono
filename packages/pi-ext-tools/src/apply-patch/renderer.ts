import { renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";

import type { ApplyPatchToolDetails } from "../apply-patch-tool.js";
import type { ApplyPatchOperationProgress } from "./outcome.js";

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
				: operation.status === "fuzzy"
					? theme.fg("warning", "!")
					: theme.fg("error", "✗");
	const score =
		operation.status === "fuzzy" && operation.score !== undefined
			? ` ${theme.fg("dim", `(${operation.score.toFixed(2)})`)}`
			: "";
	const kind =
		operation.kind === "add" ? "create" : operation.kind === "delete" ? "delete" : "modify";
	return `${glyph} ${theme.fg("success", kind)} ${theme.fg("dim", operation.path)} ${delta(operation, theme)}${score}`.trimEnd();
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

function footer(details: ApplyPatchToolDetails, theme?: Theme): string {
	const color = (role: "success" | "error" | "warning", text: string): string =>
		theme?.fg(role, text) ?? text;
	const count = (kind: ApplyPatchOperationProgress["kind"]): number =>
		operations(details).filter(
			(operation) => operation.kind === kind && operation.status !== "pending",
		).length;
	return `${color("success", `created ${count("add")}`)} · ${color("error", `deleted ${count("delete")}`)} · ${color("warning", `modified ${count("update")}`)} · ${duration(details.durationMs)}`;
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
		for (const rejected of details.rejected)
			container.addChild(new Text(theme.fg("error", rejected.error), 0, 0));
	}
	container.addChild(new Text(theme.fg("borderMuted", "─".repeat(40)), 0, 0));
	container.addChild(new Text(theme.fg("dim", footer(details, theme)), 0, 0));
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
