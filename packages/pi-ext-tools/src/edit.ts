import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	type AgentToolResult,
	createEditToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { agentResultText, isRecord, textToolResult } from "@hheei/pi-ext-core";
import * as Diff from "diff";
import { type Static, Type } from "typebox";
import { MUTATION_GLYPH, MUTATION_TONE, withMutationLock } from "./apply-patch/index.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import {
	editRemoteFile,
	REMOTE_MUTATION_DETAILS,
	type RemoteMutationDetails,
	remoteMutationDetails,
	remoteMutationFailureText,
} from "./native-remote.js";

export const MAX_HL_CHARS = 256 * 1024;

export function normalizeLineEndings(text: string): string {
	if (!text.includes("\r")) return text;
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

const EDIT_RENDER_DETAILS = "__piExtToolsEdit";
const EDIT_VIEW_KEY = "__piExtToolsEditView";

function createExecutionTool<TParams extends TypeBoxSchema, TDetails, TState>(
	factory: (cwd: string) => ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
	const template = factory(process.cwd());
	return {
		...template,
		async execute(toolCallId, params, signal, onUpdate, context) {
			return factory(context.cwd).execute(toolCallId, params, signal, onUpdate, context);
		},
	};
}

const EDIT_PARAMETERS = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(
			Type.Object({
				oldText: Type.String({
					description:
						"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
				}),
				newText: Type.String({ description: "Replacement text for this targeted edit." }),
			}),
			{
				description:
					"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
			},
		),
		target: Type.Optional(
			Type.String({
				description: "local or an authorized SSH alias. Omit for local.",
			}),
		),
	},
	{ additionalProperties: false },
);

type EditDefinition = ReturnType<typeof createEditToolDefinition>;
type EditArgs = Static<typeof EDIT_PARAMETERS>;
type EditState = Record<string, never>;

type EditOperation = {
	readonly oldText: string;
	readonly newText: string;
};

type EditOpView = {
	readonly oldContent: string;
	readonly newContent: string;
	readonly language?: string | undefined;
	readonly editLine: number;
	readonly startLine: number;
};

type EditView =
	| { readonly kind: "single"; readonly op: EditOpView }
	| { readonly kind: "multi"; readonly ops: readonly EditOpView[] };

function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function filePath(args: EditArgs): string {
	return stringField(args.path);
}

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : join(cwd, path);
}

function readTextIfSmall(path: string): string {
	try {
		if (statSync(path).size > MAX_HL_CHARS) return "";
		return normalizeLineEndings(readFileSync(path, "utf-8"));
	} catch {
		return "";
	}
}

function operationText(value: { oldText?: unknown; newText?: unknown }): EditOperation {
	return { oldText: stringField(value.oldText), newText: stringField(value.newText) };
}

export function getEditOperations(input: EditArgs): EditOperation[] {
	if (!Array.isArray(input.edits)) return [];
	return input.edits
		.map(operationText)
		.filter((edit) => edit.oldText !== "" && edit.oldText !== edit.newText);
}

function contextualOperation(file: string, operation: EditOperation): EditOpView {
	const index = file.indexOf(operation.oldText);
	if (index < 0) {
		return {
			oldContent: operation.oldText,
			newContent: operation.newText,
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
		editLine: lineNumberAt(file, index),
		startLine: lineNumberAt(file, start),
	};
}

function lineNumberAt(text: string, index: number): number {
	let line = 1;
	const limit = Math.min(index, text.length);
	for (let i = 0; i < limit; i++) {
		if (text.charCodeAt(i) === 10) line += 1;
	}
	return line;
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
	remote?: RemoteMutationDetails,
): AgentToolResult<unknown> {
	const details = isRecord(result.details) ? result.details : {};
	return {
		...result,
		details: {
			...details,
			...(metrics === undefined ? {} : { [EDIT_RENDER_DETAILS]: metrics }),
			...(view === undefined ? {} : { [EDIT_VIEW_KEY]: view }),
			...(remote === undefined ? {} : { [REMOTE_MUTATION_DETAILS]: remote }),
		},
	};
}

function _editMetrics(result: AgentToolResult<unknown>): EditMetrics | undefined {
	const value = isRecord(result.details) ? result.details[EDIT_RENDER_DETAILS] : undefined;
	if (
		!isRecord(value) ||
		typeof value.replacements !== "number" ||
		typeof value.added !== "number" ||
		typeof value.removed !== "number"
	)
		return undefined;
	return {
		replacements: value.replacements,
		added: value.added,
		removed: value.removed,
	};
}

function _editView(result: AgentToolResult<unknown>): EditView | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const value = (details as Record<string, unknown>)[EDIT_VIEW_KEY];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const kind = (value as Record<string, unknown>).kind;
	return kind === "single" || kind === "multi" ? (value as EditView) : undefined;
}

function editPresentation(
	before: string,
	_path: string,
	operations: readonly EditOperation[],
): { readonly metrics: EditMetrics | undefined; readonly view: EditView | undefined } {
	const ops = operations.map((operation) => contextualOperation(before, operation));
	const totals = ops.reduce(
		(sum, op) => {
			const patch = Diff.structuredPatch(
				"",
				"",
				normalizeLineEndings(op.oldContent),
				normalizeLineEndings(op.newContent),
				"",
				"",
				{ context: 3 },
			);
			let added = 0;
			let removed = 0;
			for (const hunk of patch.hunks) {
				for (const line of hunk.lines) {
					if (line.startsWith("+")) added++;
					else if (line.startsWith("-")) removed++;
				}
			}
			return { added: sum.added + added, removed: sum.removed + removed };
		},
		{ added: 0, removed: 0 },
	);
	return {
		metrics:
			operations.length > 0
				? { replacements: operations.length, added: totals.added, removed: totals.removed }
				: undefined,
		view:
			ops.length === 1 && ops[0] !== undefined
				? { kind: "single", op: ops[0] }
				: ops.length > 1
					? { kind: "multi", ops }
					: undefined,
	};
}

type TypeBoxSchema = import("typebox").TSchema;

export function registerEditTool(pi: ExtensionAPI, state?: FffRuntimeState): ToolDefinition {
	const baseTool = createExecutionTool(createEditToolDefinition) as ToolDefinition<
		EditDefinition["parameters"],
		unknown,
		EditState
	>;
	const tool: ToolDefinition<typeof EDIT_PARAMETERS, unknown, EditState> = {
		...baseTool,
		parameters: EDIT_PARAMETERS,
		annotations: {
			destructiveHint: true,
			idempotentHint: false,
		},
		async execute(toolCallId, params: EditArgs, signal, onUpdate, context) {
			const path = filePath(params);
			const operations = getEditOperations(params);
			if (params.target !== undefined && params.target !== "local") {
				const remote = await editRemoteFile(state, params.target, path, operations, signal);
				if (remote.outcome !== "changed" && remote.outcome !== "no_change")
					return withEditDetails(
						{
							...textToolResult(remoteMutationFailureText("Edit", remote), undefined),
							isError: true,
						},
						undefined,
						undefined,
						remote,
					);
				const presentation =
					remote.outcome === "no_change"
						? undefined
						: editPresentation(remote.before, path, operations);
				return withEditDetails(
					textToolResult(
						remote.outcome === "no_change"
							? `No changes made to ${path}.`
							: `Successfully replaced ${operations.length} block(s) in ${path}.`,
						undefined,
					),
					presentation?.metrics,
					presentation?.view,
					remote,
				);
			}
			return await withMutationLock(context.cwd, signal, async () => {
				const resolved = resolvePath(context.cwd, path);
				const before = path === "" ? "" : readTextIfSmall(resolved);
				const result = await baseTool.execute(toolCallId, params, signal, onUpdate, context);
				const presentation = editPresentation(before, path, operations);
				return withEditDetails(result, presentation.metrics, presentation.view);
			});
		},
		renderCall() {
			return new Container();
		},
		renderResult(result, _options, theme, context) {
			const remote = remoteMutationDetails(result.details);
			if (context.isError && remote?.outcome === "unconfirmed")
				return new Text(
					theme.fg(
						MUTATION_TONE.unconfirmed,
						`${MUTATION_GLYPH.unconfirmed} ${remote.target}:${remote.path} · ${remote.error ?? "outcome unknown"}`,
					),
					0,
					0,
				);
			if (context.isError && remote?.outcome === "not_applied")
				return new Text(
					theme.fg(
						MUTATION_TONE.not_applied,
						`${MUTATION_GLYPH.not_applied} ${remote.target}:${remote.path} · ${remote.error ?? "not applied"}`,
					),
					0,
					0,
				);
			if (context.isError) return new Text(agentResultText(result) || "Error", 0, 0);
			const fallback = agentResultText(result);
			return fallback === "" ? new Container() : new Text(fallback, 0, 0);
		},
	};
	pi.registerTool(tool as ToolDefinition);
	return tool as ToolDefinition;
}
