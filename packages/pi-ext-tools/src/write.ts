import { Buffer } from "node:buffer";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	type AgentToolResult,
	createWriteToolDefinition,
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
	REMOTE_MUTATION_DETAILS,
	type RemoteMutationDetails,
	remoteMutationDetails,
	remoteMutationFailureText,
	writeRemoteFile,
} from "./native-remote.js";

export const MAX_HL_CHARS = 256 * 1024;
export const MAX_RENDER_LINES = 1000;

function normalizeLineEndings(text: string): string {
	if (!text.includes("\r")) return text;
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function summarize(a: number, d: number): string {
	const parts: string[] = [];
	if (a > 0) parts.push(`+${a}`);
	if (d > 0) parts.push(`-${d}`);
	return parts.length ? parts.join(" ") : "no changes";
}

const WRITE_RENDER_DETAILS = "__piExtToolsWrite";
const WRITE_VIEW_KEY = "__piExtToolsWriteView";
const _NEW_FILE_PREVIEW_LINES = 20;
const _EXPAND_HINT = "ctrl+o to expand";

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

const WRITE_PARAMETERS = Type.Object(
	{
		path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
		content: Type.String({ description: "Content to write to the file" }),
		target: Type.Optional(
			Type.String({
				description: "local or an authorized SSH alias. Omit for local.",
			}),
		),
	},
	{ additionalProperties: false },
);

type WriteDefinition = ReturnType<typeof createWriteToolDefinition>;
type WriteArgs = Static<typeof WRITE_PARAMETERS>;
type WriteState = { targetExists?: { readonly path: string; readonly exists: boolean } };

/**
 * `renderCall` reruns on every streamed argument update and `existsSync` is a
 * synchronous syscall. The answer cannot change before this write runs, so the
 * row's renderer state keeps it for the row's lifetime.
 */
function _writeTargetExists(state: WriteState, cwd: string, path: string): boolean {
	const cached = state.targetExists;
	if (cached !== undefined && cached.path === path) return cached.exists;
	const exists = existsSync(resolvePath(cwd, path));
	state.targetExists = { path, exists };
	return exists;
}

type WriteDiffLine = {
	readonly type: "add" | "del" | "ctx" | "sep";
	readonly oldNum: number | null;
	readonly newNum: number | null;
	readonly content: string;
};

type WriteView =
	| {
			readonly kind: "diff";
			readonly summary: string;
			readonly language?: string | undefined;
			readonly added?: number;
			readonly removed?: number;
			readonly chars?: number;
			readonly lines?: readonly WriteDiffLine[];
	  }
	| {
			readonly kind: "new";
			readonly lines: number;
			readonly language?: string | undefined;
			readonly content?: string;
	  }
	| {
			readonly kind: "replace";
			readonly lines: number;
			readonly language?: string | undefined;
			readonly content?: string;
	  }
	| { readonly kind: "noChange" };

function filePath(args: WriteArgs): string {
	return typeof args.path === "string" ? args.path : "";
}

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : join(cwd, path);
}

function readTextIfSmall(path: string): { exists: boolean; text?: string } {
	try {
		const size = statSync(path).size;
		if (size > MAX_HL_CHARS) return { exists: true };
		return { exists: true, text: readFileSync(path, "utf-8") };
	} catch {
		return { exists: false };
	}
}

function countContentLines(content: string): number {
	let len = content.length;
	while (len > 0) {
		const c = content.charCodeAt(len - 1);
		if (c === 10 || c === 13) len -= 1;
		else break;
	}
	if (len === 0) return 0;
	let count = 1;
	for (let i = 0; i < len; i++) {
		if (content.charCodeAt(i) === 10) count += 1;
	}
	return count;
}

function writeMetrics(args: WriteArgs): { bytes: number; lines: number } | undefined {
	if (typeof args.content !== "string") return undefined;
	return { bytes: Buffer.byteLength(args.content), lines: countContentLines(args.content) };
}

function withWriteDetails(
	result: AgentToolResult<unknown>,
	metrics: { bytes: number; lines: number } | undefined,
	view: WriteView | undefined,
	remote?: RemoteMutationDetails,
): AgentToolResult<unknown> {
	const details = isRecord(result.details) ? result.details : {};
	return {
		...result,
		details: {
			...details,
			...(metrics === undefined ? {} : { [WRITE_RENDER_DETAILS]: metrics }),
			...(view === undefined ? {} : { [WRITE_VIEW_KEY]: view }),
			...(remote === undefined ? {} : { [REMOTE_MUTATION_DETAILS]: remote }),
		},
	};
}

function _readWriteMetrics(
	result: AgentToolResult<unknown>,
): { bytes: number; lines: number } | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const value = (details as Record<string, unknown>)[WRITE_RENDER_DETAILS];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return typeof (value as Record<string, unknown>).bytes === "number" &&
		typeof (value as Record<string, unknown>).lines === "number"
		? {
				bytes: (value as { bytes: number }).bytes,
				lines: (value as { lines: number }).lines,
			}
		: undefined;
}

function _writeView(result: AgentToolResult<unknown>): WriteView | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const value = (details as Record<string, unknown>)[WRITE_VIEW_KEY];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const kind = (value as Record<string, unknown>).kind;
	return kind === "diff" || kind === "new" || kind === "replace" || kind === "noChange"
		? (value as WriteView)
		: undefined;
}

function persistWriteDiff(oldText: string, newText: string): Extract<WriteView, { kind: "diff" }> {
	const patch = Diff.structuredPatch(
		"",
		"",
		normalizeLineEndings(oldText),
		normalizeLineEndings(newText),
		"",
		"",
		{ context: 3 },
	);
	const lines: {
		type: "add" | "del" | "ctx" | "sep";
		oldNum: number | null;
		newNum: number | null;
		content: string;
	}[] = [];
	let added = 0;
	let removed = 0;
	for (let hi = 0; hi < patch.hunks.length; hi++) {
		const h = patch.hunks[hi];
		if (!h) continue;
		if (hi > 0) {
			const prev = patch.hunks[hi - 1];
			const gap = prev ? h.oldStart - (prev.oldStart + prev.oldLines) : 0;
			lines.push({ type: "sep", oldNum: null, newNum: gap > 0 ? gap : null, content: "" });
		}
		let oL = h.oldStart;
		let nL = h.newStart;
		for (const raw of h.lines) {
			if (raw === "\\ No newline at end of file") continue;
			const ch = raw[0];
			const text = raw.slice(1);
			if (ch === "+") {
				lines.push({ type: "add", oldNum: null, newNum: nL++, content: text });
				added++;
			} else if (ch === "-") {
				lines.push({ type: "del", oldNum: oL++, newNum: null, content: text });
				removed++;
			} else {
				lines.push({ type: "ctx", oldNum: oL++, newNum: nL++, content: text });
			}
		}
	}
	return {
		kind: "diff",
		summary: summarize(added, removed),
		added,
		removed,
		chars: oldText.length + newText.length,
		lines: lines.slice(0, MAX_RENDER_LINES),
	};
}

function writePresentation(
	args: WriteArgs,
	baseline: { readonly exists: boolean; readonly text?: string },
): { readonly metrics: { bytes: number; lines: number } | undefined; readonly view: WriteView } {
	const content = typeof args.content === "string" ? args.content : "";
	const old = baseline.text;
	const metrics = writeMetrics(args);
	const preview = { lines: metrics?.lines ?? 0 };
	const view: WriteView = !baseline.exists
		? { kind: "new", ...preview }
		: old !== undefined &&
				content.length <= MAX_HL_CHARS &&
				normalizeLineEndings(old) !== normalizeLineEndings(content)
			? persistWriteDiff(old, content)
			: old !== undefined && normalizeLineEndings(old) === normalizeLineEndings(content)
				? { kind: "noChange" }
				: { kind: "replace", ...preview };
	return { metrics, view };
}

type TypeBoxSchema = import("typebox").TSchema;

export function registerWriteTool(pi: ExtensionAPI, state?: FffRuntimeState): ToolDefinition {
	const baseTool = createExecutionTool(createWriteToolDefinition) as ToolDefinition<
		WriteDefinition["parameters"],
		unknown,
		WriteState
	>;
	const tool: ToolDefinition<typeof WRITE_PARAMETERS, unknown, WriteState> = {
		...baseTool,
		parameters: WRITE_PARAMETERS,
		annotations: {
			destructiveHint: true,
			idempotentHint: true,
		},
		async execute(toolCallId, params: WriteArgs, signal, onUpdate, context) {
			const path = filePath(params);
			if (params.target !== undefined && params.target !== "local") {
				const content = typeof params.content === "string" ? params.content : "";
				const remote = await writeRemoteFile(state, params.target, path, content, signal);
				if (remote.outcome !== "changed" && remote.outcome !== "no_change")
					return withWriteDetails(
						{
							...textToolResult(remoteMutationFailureText("Write", remote), undefined),
							isError: true,
						},
						undefined,
						undefined,
						remote,
					);
				const baseline = {
					exists: remote.existed,
					...(remote.before === undefined ? {} : { text: new TextDecoder().decode(remote.before) }),
				};
				const presentation = writePresentation(params, baseline);
				return withWriteDetails(
					textToolResult(
						remote.outcome === "no_change"
							? `No changes made to ${path}.`
							: `Successfully wrote ${Buffer.byteLength(content)} bytes to ${path}`,
						undefined,
					),
					presentation.metrics,
					presentation.view,
					remote,
				);
			}
			return await withMutationLock(context.cwd, signal, async () => {
				const resolved = resolvePath(context.cwd, path);
				const baseline = path === "" ? { exists: false } : readTextIfSmall(resolved);
				const result = await baseTool.execute(toolCallId, params, signal, onUpdate, context);
				const presentation = writePresentation(params, baseline);
				return withWriteDetails(result, presentation.metrics, presentation.view);
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
