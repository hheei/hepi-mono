import { Text } from "@earendil-works/pi-tui";
import { parseV4aPatch, type V4aPatchOperation, type V4aUpdateLine } from "./parser.js";

export interface ApplyPatchTheme {
	fg(role: string, text: string): string;
	bold(text: string): string;
}

export interface ApplyPatchRenderContext {
	readonly toolCallId?: string;
	readonly cwd?: string;
	readonly argsComplete?: boolean;
	readonly expanded?: boolean;
	readonly showCollapsedDiff?: boolean;
}

export type ApplyPatchRenderStatus = "pending" | "success" | "partial" | "failed";

interface ApplyPatchRenderState {
	readonly status: ApplyPatchRenderStatus;
	readonly failedOperationIndices: ReadonlySet<number>;
}

const renderStates = new Map<string, ApplyPatchRenderState>();
const RENDER_STATE_LIMIT = 50;

function cacheRenderState(toolCallId: string, state: ApplyPatchRenderState): void {
	renderStates.delete(toolCallId);
	renderStates.set(toolCallId, state);
	while (renderStates.size > RENDER_STATE_LIMIT) {
		const oldest = renderStates.keys().next().value;
		if (oldest === undefined) return;
		renderStates.delete(oldest);
	}
}

export function setApplyPatchRenderState(toolCallId: string): void {
	cacheRenderState(toolCallId, {
		status: "pending",
		failedOperationIndices: new Set(),
	});
}

export function finishApplyPatchRenderState(
	toolCallId: string,
	status: Exclude<ApplyPatchRenderStatus, "pending">,
	failedOperationIndices: readonly number[] = [],
): void {
	cacheRenderState(toolCallId, {
		status,
		failedOperationIndices: new Set(failedOperationIndices),
	});
}

export function clearApplyPatchRenderStates(): void {
	renderStates.clear();
}

function renderState(toolCallId: string | undefined): ApplyPatchRenderState | undefined {
	if (toolCallId === undefined) return undefined;
	const state = renderStates.get(toolCallId);
	if (state === undefined) return undefined;
	cacheRenderState(toolCallId, state);
	return state;
}

function operationStatus(
	state: ApplyPatchRenderState | undefined,
	index: number,
): "pending" | "success" | "failed" {
	if (state === undefined || state.status === "pending") return "pending";
	if (state.status === "failed" || state.failedOperationIndices.has(index)) return "failed";
	return "success";
}

function statusGlyph(status: "pending" | "success" | "failed"): string {
	return status === "pending" ? "◐" : status === "success" ? "✓" : "✗";
}

function statusRole(status: "pending" | "success" | "failed"): string {
	return status === "pending" ? "warning" : status === "success" ? "success" : "error";
}

function countContent(content: string): number {
	return content.length === 0
		? 0
		: content.split(/\r?\n/).filter((line, i, all) => i < all.length - 1 || line !== "").length;
}

function counts(operation: V4aPatchOperation): { added: number; removed: number } {
	if (operation.kind === "add") return { added: countContent(operation.content), removed: 0 };
	if (operation.kind === "delete") return { added: 0, removed: 0 };
	return operation.hunks.reduce(
		(result, hunk) => {
			for (const line of hunk.lines) {
				if (line.kind === "add") result.added += 1;
				if (line.kind === "remove") result.removed += 1;
			}
			return result;
		},
		{ added: 0, removed: 0 },
	);
}

function target(operation: V4aPatchOperation): string {
	return operation.kind === "update" && operation.moveTo
		? `${operation.path} → ${operation.moveTo}`
		: operation.path;
}

function verb(operation: V4aPatchOperation): "Created" | "Deleted" | "Edited" {
	return operation.kind === "add" ? "Created" : operation.kind === "delete" ? "Deleted" : "Edited";
}

function delta(added: number, removed: number): string {
	return `+${added} -${removed}`;
}

function branch(index: number, total: number): string {
	return index === total - 1 ? "└─" : "├─";
}

function successCount(
	operations: readonly V4aPatchOperation[],
	state: ApplyPatchRenderState | undefined,
): number {
	if (state?.status === "success") return operations.length;
	if (state?.status === "partial") return operations.length - state.failedOperationIndices.size;
	return 0;
}

function operationLine(
	operation: V4aPatchOperation,
	index: number,
	state: ApplyPatchRenderState | undefined,
): string {
	const c = counts(operation);
	const status = operationStatus(state, index);
	return `${statusGlyph(status)} ${verb(operation)} ${target(operation)} ${delta(c.added, c.removed)}`;
}

function summary(
	operations: readonly V4aPatchOperation[],
	state: ApplyPatchRenderState | undefined,
): string {
	if (operations.length === 0) return "";
	if (operations.length === 1) {
		const [operation] = operations;
		if (operation === undefined) return "";
		return operationLine(operation, 0, state);
	}
	const completed = successCount(operations, state);
	const rootStatus =
		state?.status === "success" ? "success" : state?.status === "failed" ? "failed" : "pending";
	return [
		`${statusGlyph(rootStatus)} Edited ${operations.length} files (${completed}/${operations.length})`,
		...operations.map(
			(operation, index) =>
				`${branch(index, operations.length)} ${operationLine(operation, index, state)}`,
		),
	].join("\n");
}

function expanded(
	operations: readonly V4aPatchOperation[],
	state: ApplyPatchRenderState | undefined,
): string {
	const lines: string[] = [];
	for (const [index, op] of operations.entries()) {
		if (index > 0) lines.push("");
		lines.push(
			operations.length === 1
				? operationLine(op, index, state)
				: `${branch(index, operations.length)} ${operationLine(op, index, state)}`,
		);
		if (op.kind === "add")
			for (const line of op.content.split(/(?<=\n)/))
				if (line) lines.push(`    + ${line.replace(/\n$/, "")}`);
		if (op.kind === "update") {
			for (const hunk of op.hunks) {
				if (hunk.anchor) lines.push(`    @@${hunk.anchor}`);
				for (const line of hunk.lines) lines.push(`    ${formatUpdateLine(line)}`);
			}
		}
	}
	return lines.join("\n");
}

function formatUpdateLine(line: V4aUpdateLine): string {
	const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
	return `${marker} ${line.text.replace(/\r?\n$/, "")}`;
}

function streaming(text: string): string {
	// Keep streamed rendering bounded; Pi can invoke this for every partial argument update.
	if (text.length > 256 * 1024) return "Patching";
	const actions: {
		kind: "add" | "delete" | "update";
		path: string;
		move?: string;
		added: number;
		removed: number;
	}[] = [];
	let current: (typeof actions)[number] | undefined;
	let started = false;
	for (const raw of text.split(/\r?\n/)) {
		if (!started) {
			if (raw.trim() === "*** Begin Patch") started = true;
			continue;
		}
		if (raw.trim() === "*** End Patch") break;
		const header = raw.match(/^\*\*\* (Add|Delete|Update) File: (.+)$/);
		if (header) {
			const [, label, path] = header;
			const kind =
				label === "Add"
					? "add"
					: label === "Delete"
						? "delete"
						: label === "Update"
							? "update"
							: undefined;
			if (kind === undefined || path === undefined) continue;
			current = {
				kind,
				path,
				added: 0,
				removed: 0,
			};
			actions.push(current);
			continue;
		}
		if (!current) continue;
		if (current.kind === "update" && raw.startsWith("*** Move to: ")) {
			current.move = raw.slice(13);
			continue;
		}
		if (current.kind !== "delete" && raw.startsWith("+")) current.added += 1;
		if (current.kind === "update" && raw.startsWith("-")) current.removed += 1;
	}
	if (actions.length === 0) return "Patching";
	return actions
		.map((action, index) => {
			const line = `${statusGlyph("pending")} ${action.kind === "add" ? "Created" : action.kind === "delete" ? "Deleted" : "Edited"} ${action.move ? `${action.path} → ${action.move}` : action.path} ${delta(action.added, action.removed)}`;
			return actions.length === 1 ? line : `${branch(index, actions.length)} ${line}`;
		})
		.join("\n");
}

function colorStatusLine(line: string, theme: ApplyPatchTheme): string {
	let rest = line;
	let tree = "";
	if (rest.startsWith("├─ ") || rest.startsWith("└─ ")) {
		tree = rest.slice(0, 3);
		rest = rest.slice(3);
	}
	const glyph = rest.slice(0, 1);
	if (glyph !== "✓" && glyph !== "✗" && glyph !== "◐") return theme.fg("dim", line);
	if (rest[1] !== " ") return theme.fg("dim", line);
	rest = rest.slice(2);
	const status = glyph === "✓" ? "success" : glyph === "✗" ? "failed" : "pending";
	const actionWithDelta = rest.match(/^(Created|Deleted|Edited|Changed)(.*?)( \+\d+ -\d+)$/);
	const actionOnly = rest.match(/^(Created|Deleted|Edited|Changed)(.*)$/);
	const action = actionWithDelta?.[1] ?? actionOnly?.[1];
	const label = actionWithDelta?.[2] ?? actionOnly?.[2];
	const deltaText = actionWithDelta?.[3];
	if (action === undefined || label === undefined) return theme.fg("dim", line);
	const actionRole = action === "Created" ? "success" : action === "Deleted" ? "error" : "accent";
	const coloredDelta =
		deltaText === undefined
			? ""
			: ` ${theme.fg("success", deltaText.trim().split(" ")[0] ?? "")} ${theme.fg("error", deltaText.trim().split(" ")[1] ?? "")}`;
	return `${tree === "" ? "" : theme.fg("dim", tree)}${theme.fg(statusRole(status), glyph)} ${theme.fg(actionRole, action)}${theme.fg("dim", label)}${coloredDelta}`;
}

export function renderApplyPatchCall(
	args: unknown,
	theme: ApplyPatchTheme,
	context: ApplyPatchRenderContext = {},
): Text {
	const patch =
		typeof args === "object" && args !== null && "patch" in args && typeof args.patch === "string"
			? args.patch
			: "";
	let body: string;
	if (context.argsComplete === false) body = streaming(patch);
	else {
		try {
			const operations = parseV4aPatch(patch).operations;
			const state = renderState(context.toolCallId);
			body =
				context.expanded || context.showCollapsedDiff
					? expanded(operations, state)
					: summary(operations, state);
		} catch {
			body = "Patching";
		}
	}
	const colored = body
		.split("\n")
		.map((line) => {
			if (line === "Patching") return theme.fg("dim", line);
			if (/^\s+\+ /.test(line)) return theme.fg("success", line);
			if (/^\s+- /.test(line)) return theme.fg("error", line);
			if (/^\s+@@/.test(line)) return theme.fg("dim", line);
			return colorStatusLine(line, theme);
		})
		.join("\n");
	return new Text(`${theme.fg("toolTitle", theme.bold("apply_patch"))}\n\n${colored}`, 0, 0);
}
