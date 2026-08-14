import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	type AgentToolResult,
	createEditToolDefinition,
	type ExtensionAPI,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { createCanonicalExecutionTool, registerCanonicalManagedTool } from "./native-tool.js";
import { MAX_RENDER_LINES } from "./pretty/config.js";
import { parseDiff } from "./pretty/diff.js";
import {
	renderDiffSummary,
	renderSplit,
	resolveDiffColors,
	summarize,
} from "./pretty/diff-render.js";
import type { ToolTui } from "./pretty/frame.js";
import { lang } from "./pretty/lang.js";
import { LinesBody } from "./pretty/lines-body.js";

const EDIT_RENDER_DETAILS = "__piExtToolsEdit";
const EDIT_VIEW_KEY = "__piExtToolsEditView";

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
};

type EditView =
	| { readonly kind: "single"; readonly summary: string; readonly op: EditOpView }
	| { readonly kind: "multi"; readonly summary: string; readonly ops: readonly EditOpView[] };

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

function opEditLine(file: string, needle: string): number {
	if (file === "" || needle === "") return 0;
	const index = file.indexOf(needle);
	return index >= 0 ? file.slice(0, index).split("\n").length : 0;
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function withEditDetails(
	result: AgentToolResult<unknown>,
	replacements: number | undefined,
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
			...(replacements === undefined ? {} : { [EDIT_RENDER_DETAILS]: { replacements } }),
			...(view === undefined ? {} : { [EDIT_VIEW_KEY]: view }),
		},
	};
}

function editMetrics(result: AgentToolResult<unknown>): { replacements: number } | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const value = (details as Record<string, unknown>)[EDIT_RENDER_DETAILS];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return typeof (value as Record<string, unknown>).replacements === "number"
		? { replacements: (value as { replacements: number }).replacements }
		: undefined;
}

function editView(result: AgentToolResult<unknown>): EditView | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const value = (details as Record<string, unknown>)[EDIT_VIEW_KEY];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const kind = (value as Record<string, unknown>).kind;
	return kind === "single" || kind === "multi" ? (value as EditView) : undefined;
}

function renderEditDiff(ops: readonly EditOpView[], theme: Theme, width: number): string[] {
	const colors = resolveDiffColors(theme);
	const blocks = ops.map((op) => {
		const parsed = parseDiff(op.oldContent, op.newContent, 3, op.editLine);
		return renderSplit(parsed, op.language, MAX_RENDER_LINES, colors, width);
	});
	return blocks.join("\n···\n").split("\n");
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
			let before = "";
			try {
				if (path !== "" && existsSync(resolved)) before = readFileSync(resolved, "utf-8");
			} catch {
				before = "";
			}
			const result = await baseTool.execute(toolCallId, params, signal, onUpdate, context);
			const operations = getEditOperations(params);
			const language = lang(path);
			const ops = operations.map((operation) => ({
				oldContent: operation.oldText,
				newContent: operation.newText,
				language,
				editLine: opEditLine(before, operation.oldText),
			}));
			const totals = ops.reduce(
				(sum, op) => {
					const parsed = parseDiff(op.oldContent, op.newContent);
					return { added: sum.added + parsed.added, removed: sum.removed + parsed.removed };
				},
				{ added: 0, removed: 0 },
			);
			const added = totals.added;
			const removed = totals.removed;
			const summary = summarize(added, removed);
			const view: EditView | undefined =
				ops.length === 1 && ops[0] !== undefined
					? { kind: "single", summary, op: ops[0] }
					: ops.length > 1
						? { kind: "multi", summary, ops }
						: undefined;
			return withEditDetails(result, operations.length > 0 ? operations.length : undefined, view);
		},
		renderCall() {
			return new Container();
		},
		renderResult(result, _options, theme, context) {
			if (context.isError) return new Text(resultText(result) || "Error", 0, 0);
			const view = editView(result);
			if (view === undefined) return new Container();
			const ops = view.kind === "single" ? [view.op] : view.ops;
			const loc =
				view.kind === "single" && view.op.editLine > 0
					? ` ${theme.fg("muted", `at line ${view.op.editLine}`)}`
					: "";
			const heading =
				view.kind === "single"
					? `${renderDiffSummary(view.summary, theme)}${loc}`
					: `${theme.fg("muted", `${view.ops.length} edits`)} ${renderDiffSummary(view.summary, theme)}`;
			return new LinesBody((width) => [heading, ...renderEditDiff(ops, theme, width)]);
		},
	};
	registerCanonicalManagedTool(
		pi,
		tui.frame(tool, {
			summary: (args) => {
				const path = filePath(args as EditArgs);
				const operations = getEditOperations(args as EditArgs);
				if (operations.length === 0) return path || undefined;
				const totals = operations.reduce(
					(sum, operation) => {
						const parsed = parseDiff(operation.oldText, operation.newText);
						return { added: sum.added + parsed.added, removed: sum.removed + parsed.removed };
					},
					{ added: 0, removed: 0 },
				);
				const delta = summarize(totals.added, totals.removed);
				return path === "" ? delta : `${path} ${delta}`;
			},
			maxBodyLines: Number.POSITIVE_INFINITY,
			footer(result, completion) {
				const replacements = editMetrics(result)?.replacements;
				const duration = durationText(completion?.durationMs);
				return [
					replacements === undefined
						? undefined
						: `${replacements} replacement${replacements === 1 ? "" : "s"}`,
					duration,
				]
					.filter((value): value is string => value !== undefined)
					.join(" · ");
			},
		}),
		[],
	);
}
