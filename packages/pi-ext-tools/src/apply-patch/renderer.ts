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

function summary(operations: readonly V4aPatchOperation[]): string {
	const total = operations.reduce(
		(r, op) => {
			const c = counts(op);
			return { added: r.added + c.added, removed: r.removed + c.removed };
		},
		{ added: 0, removed: 0 },
	);
	if (operations.length === 1) {
		const [op] = operations;
		if (op === undefined) return "";
		const c = counts(op);
		return `${verb(op)} ${target(op)} ${delta(c.added, c.removed)}`;
	}
	return [
		`Edited ${operations.length} files ${delta(total.added, total.removed)}`,
		...operations.map((op) => {
			const c = counts(op);
			return `  └ ${verb(op)} ${target(op)} ${delta(c.added, c.removed)}`;
		}),
	].join("\n");
}

function expanded(operations: readonly V4aPatchOperation[]): string {
	const lines: string[] = [];
	for (const [index, op] of operations.entries()) {
		if (index > 0) lines.push("");
		const c = counts(op);
		lines.push(`${verb(op)} ${target(op)} ${delta(c.added, c.removed)}`);
		if (op.kind === "add")
			for (const line of op.content.split(/(?<=\n)/))
				if (line) lines.push(`+ ${line.replace(/\n$/, "")}`);
		if (op.kind === "update") {
			for (const hunk of op.hunks) {
				if (hunk.anchor) lines.push(`@@${hunk.anchor}`);
				for (const line of hunk.lines) lines.push(formatUpdateLine(line));
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
		.map(
			(action) =>
				`${action.kind === "add" ? "Created" : action.kind === "delete" ? "Deleted" : "Edited"} ${action.move ? `${action.path} → ${action.move}` : action.path} ${delta(action.added, action.removed)}`,
		)
		.join("\n");
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
			body =
				context.expanded || context.showCollapsedDiff ? expanded(operations) : summary(operations);
		} catch {
			body = "Patching";
		}
	}
	const colored = body
		.split("\n")
		.map((line) => {
			if (line === "Patching") return theme.fg("dim", line);
			if (line.startsWith("+ ")) return theme.fg("success", line);
			if (line.startsWith("- ")) return theme.fg("error", line);
			const match = line.match(/^(Created|Deleted|Edited|Changed)(.*?)( \+\d+ -\d+)$/);
			if (!match) return theme.fg("dim", line);
			const [, action, label, deltaText] = match;
			if (action === undefined || label === undefined || deltaText === undefined)
				return theme.fg("dim", line);
			const [added, removed] = deltaText.trim().split(" ");
			if (added === undefined || removed === undefined) return theme.fg("dim", line);
			const role = action === "Created" ? "success" : action === "Deleted" ? "error" : "accent";
			return `${theme.fg(role, action)}${theme.fg("dim", label)} ${theme.fg("success", added)} ${theme.fg("error", removed)}`;
		})
		.join("\n");
	return new Text(`${theme.fg("toolTitle", theme.bold("apply_patch"))}\n\n${colored}`, 0, 0);
}
