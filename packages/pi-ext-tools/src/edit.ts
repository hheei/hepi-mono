import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	type AgentToolResult,
	createEditToolDefinition,
	type ExtensionAPI,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { ToolTui } from "@hheei/pi-ext-core";
import {
	createCanonicalExecutionTool,
	createCanonicalToolRegistration,
	registerCanonicalTool,
} from "./native-tool.js";
import { MAX_HL_CHARS, MAX_RENDER_LINES } from "./pretty/config.js";
import { type ParsedDiff, parseDiff, parseUnifiedPatch } from "./pretty/diff.js";
import {
	renderDiffOmission,
	renderSplit,
	resolveDiffColors,
	summarize,
} from "./pretty/diff-render.js";
import { lang } from "./pretty/lang.js";
import { LinesBody } from "./pretty/lines-body.js";

const EDIT_RENDER_DETAILS = "__piExtToolsEdit";
const EDIT_VIEW_KEY = "__piExtToolsEditView";
export const EDIT_TOOL_REGISTRATION = createCanonicalToolRegistration("edit", ["apply_patch"]);

type EditDefinition = ReturnType<typeof createEditToolDefinition>;
type EditArgs = Parameters<NonNullable<EditDefinition["renderCall"]>>[0];
type EditState = Record<string, never>;

type EditOperation = {
	readonly oldText: string;
	readonly newText: string;
};

type EditOpView = {
	readonly oldContent: string;
	readonly newContent: string;
	readonly language: string | undefined;
	readonly editLine: number;
	readonly startLine: number;
};

type EditView =
	| { readonly kind: "single"; readonly op: EditOpView }
	| { readonly kind: "multi"; readonly ops: readonly EditOpView[] };

function durationText(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	return durationMs < 1_000 ? `${durationMs}ms` : `${(durationMs / 1_000).toFixed(1)}s`;
}

function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function filePath(args: EditArgs): string {
	const extra = args as EditArgs & { file_path?: unknown };
	return stringField(args.path) || stringField(extra.file_path);
}

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : join(cwd, path);
}

function readTextIfSmall(path: string): string {
	try {
		if (statSync(path).size > MAX_HL_CHARS) return "";
		return readFileSync(path, "utf-8").replaceAll("\r\n", "\n");
	} catch {
		return "";
	}
}

function operationText(value: {
	oldText?: unknown;
	newText?: unknown;
	old_text?: unknown;
	new_text?: unknown;
}): EditOperation {
	return {
		oldText: stringField(value.oldText) || stringField(value.old_text),
		newText: stringField(value.newText) || stringField(value.new_text),
	};
}

export function getEditOperations(input: EditArgs): EditOperation[] {
	const fromArray = Array.isArray(input.edits)
		? input.edits
				.map(operationText)
				.filter((edit) => edit.oldText !== "" && edit.oldText !== edit.newText)
		: [];
	if (fromArray.length > 0) return fromArray;
	const top = operationText(
		input as EditArgs & {
			oldText?: unknown;
			newText?: unknown;
			old_text?: unknown;
			new_text?: unknown;
		},
	);
	return top.oldText !== "" && top.oldText !== top.newText ? [top] : [];
}

function contextualOperation(
	file: string,
	operation: EditOperation,
	language: string | undefined,
): EditOpView {
	const index = file.indexOf(operation.oldText);
	if (index < 0) {
		return {
			oldContent: operation.oldText,
			newContent: operation.newText,
			language,
			editLine: 0,
			startLine: 0,
		};
	}

	let start = file.lastIndexOf("\n", index - 1) + 1;
	for (let remaining = 3; remaining > 0 && start > 0; remaining--) {
		start = file.lastIndexOf("\n", start - 2) + 1;
	}
	let end = file.indexOf("\n", index + operation.oldText.length);
	if (end < 0) {
		end = file.length;
	} else {
		for (let remaining = 3; remaining > 0; remaining--) {
			const next = file.indexOf("\n", end + 1);
			if (next < 0) {
				end = file.length;
				break;
			}
			end = next;
		}
		if (end < file.length) end++;
	}
	return {
		oldContent: file.slice(start, end),
		newContent: `${file.slice(start, index)}${operation.newText}${file.slice(
			index + operation.oldText.length,
			end,
		)}`,
		language,
		editLine: file.slice(0, index).split("\n").length,
		startLine: file.slice(0, start).split("\n").length,
	};
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

type EditMetrics = {
	readonly replacements: number;
	readonly added: number;
	readonly removed: number;
};

function withEditDetails(
	result: AgentToolResult<unknown>,
	metrics: EditMetrics | undefined,
	view: EditView | undefined,
): AgentToolResult<unknown> {
	const details =
		typeof result.details === "object" && result.details !== null && !Array.isArray(result.details)
			? result.details
			: {};
	return {
		...result,
		details: {
			...details,
			...(metrics === undefined ? {} : { [EDIT_RENDER_DETAILS]: metrics }),
			...(view === undefined ? {} : { [EDIT_VIEW_KEY]: view }),
		},
	};
}

function editMetrics(result: AgentToolResult<unknown>): EditMetrics | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const record = details as Record<string, unknown>;
	const value = record[EDIT_RENDER_DETAILS];
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const metrics = value as Record<string, unknown>;
		if (
			typeof metrics.replacements === "number" &&
			typeof metrics.added === "number" &&
			typeof metrics.removed === "number"
		)
			return {
				replacements: metrics.replacements,
				added: metrics.added,
				removed: metrics.removed,
			};
	}
	const view = record[EDIT_VIEW_KEY];
	if (typeof view === "object" && view !== null && !Array.isArray(view)) {
		const legacy = view as Record<string, unknown>;
		if (
			typeof legacy.edits === "number" &&
			typeof legacy.added === "number" &&
			typeof legacy.removed === "number"
		)
			return {
				replacements: legacy.edits,
				added: legacy.added,
				removed: legacy.removed,
			};
	}
	const diff = legacyEditDiff(result);
	if (diff === undefined) return undefined;
	const patch = record.patch;
	const hunks = typeof patch === "string" ? (patch.match(/^@@/gm)?.length ?? 0) : 0;
	return {
		replacements: Math.max(1, hunks),
		added: diff.added,
		removed: diff.removed,
	};
}

function editView(result: AgentToolResult<unknown>): EditView | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const value = (details as Record<string, unknown>)[EDIT_VIEW_KEY];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const kind = (value as Record<string, unknown>).kind;
	return kind === "single" || kind === "multi" ? (value as EditView) : undefined;
}

function legacyEditDiff(result: AgentToolResult<unknown>): ParsedDiff | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const patch = (details as Record<string, unknown>).patch;
	return typeof patch === "string" ? parseUnifiedPatch(patch) : undefined;
}

function maxNumberWidth(diffs: readonly ReturnType<typeof parseDiff>[]): number {
	let max = 0;
	for (const diff of diffs) {
		for (const line of diff.lines) {
			const n = Math.max(line.oldNum ?? 0, line.newNum ?? 0);
			if (n > max) max = n;
		}
	}
	return Math.max(2, String(max).length);
}

function renderEditDiff(ops: readonly EditOpView[], theme: Theme, width: number): string[] {
	const colors = resolveDiffColors(theme);
	const diffs = ops.map((op) => parseDiff(op.oldContent, op.newContent, 3, op.startLine));
	const numberWidth = maxNumberWidth(diffs);
	const blocks = diffs.map((parsed, index) =>
		renderSplit(parsed, ops[index]?.language, MAX_RENDER_LINES, colors, width, false, numberWidth),
	);
	return blocks.join(`\n${renderDiffOmission(numberWidth)}\n`).split("\n");
}

function renderLegacyEditDiff(
	diff: ParsedDiff,
	language: string | undefined,
	theme: Theme,
	width: number,
): string[] {
	return renderSplit(
		diff,
		language,
		MAX_RENDER_LINES,
		resolveDiffColors(theme),
		width,
		false,
		maxNumberWidth([diff]),
	).split("\n");
}

function editFooter(
	metrics: EditMetrics | undefined,
	durationMs: number | undefined,
): string | undefined {
	const duration = durationText(durationMs);
	if (metrics === undefined) return duration;
	const edits = `${metrics.replacements} edit${metrics.replacements === 1 ? "" : "s"}`;
	const lines =
		metrics.added > 0 || metrics.removed > 0
			? `${summarize(metrics.added, metrics.removed)} lines`
			: undefined;
	return [edits, lines, duration]
		.filter((value): value is string => value !== undefined)
		.join(" · ");
}

export function registerEditTool(pi: ExtensionAPI, tui: ToolTui): void {
	const baseTool = createCanonicalExecutionTool(createEditToolDefinition) as ToolDefinition<
		EditDefinition["parameters"],
		unknown,
		EditState
	>;
	const tool: ToolDefinition<EditDefinition["parameters"], unknown, EditState> = {
		...baseTool,
		async execute(toolCallId, params: EditArgs, signal, onUpdate, context) {
			const path = filePath(params);
			const resolved = resolvePath(context.cwd, path);
			const before = path === "" ? "" : readTextIfSmall(resolved);
			const result = await baseTool.execute(toolCallId, params, signal, onUpdate, context);
			const operations = getEditOperations(params);
			const language = lang(path);
			const ops = operations.map((operation) => contextualOperation(before, operation, language));
			const totals = ops.reduce(
				(sum, op) => {
					const parsed = parseDiff(op.oldContent, op.newContent);
					return { added: sum.added + parsed.added, removed: sum.removed + parsed.removed };
				},
				{ added: 0, removed: 0 },
			);
			const view: EditView | undefined =
				ops.length === 1 && ops[0] !== undefined
					? { kind: "single", op: ops[0] }
					: ops.length > 1
						? { kind: "multi", ops }
						: undefined;
			return withEditDetails(
				result,
				operations.length > 0
					? {
							replacements: operations.length,
							added: totals.added,
							removed: totals.removed,
						}
					: undefined,
				view,
			);
		},
		renderCall() {
			return new Container();
		},
		renderResult(result, _options, theme, context) {
			if (context.isError) return new Text(resultText(result) || "Error", 0, 0);
			const view = editView(result);
			if (view !== undefined) {
				const ops = view.kind === "single" ? [view.op] : view.ops;
				return new LinesBody((width) => renderEditDiff(ops, theme, width));
			}
			const diff = legacyEditDiff(result);
			if (diff === undefined) {
				const fallback = resultText(result);
				return fallback === "" ? new Container() : new Text(fallback, 0, 0);
			}
			const language = lang(filePath(context.args as EditArgs));
			return new LinesBody((width) => renderLegacyEditDiff(diff, language, theme, width));
		},
	};
	registerCanonicalTool(
		pi,
		EDIT_TOOL_REGISTRATION,
		tui.frame(tool, {
			summary: (args) => filePath(args as EditArgs) || undefined,
			summarySeparator: "space",
			maxBodyLines: Number.POSITIVE_INFINITY,
			footer(result, completion) {
				return editFooter(editMetrics(result), completion?.durationMs);
			},
		}),
	);
}
