import {
	type AgentToolResult,
	copyToClipboard as copyToSystemClipboard,
	getLanguageFromPath,
	highlightCode,
	type Theme,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	stripTerminalSequences,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ToolPresentationProvider } from "@hheei/pi-ext-core";
import { inlinePresentation, type NestedCallRecord, type ToolRenderContext } from "./renderer.js";
import {
	type Collapsible,
	type FoldLevel,
	ToolView,
	toContentRows,
	toSingleRow,
	transitionFoldLevel,
} from "./tool-view.js";
import type { CapturedToolCall } from "./tracker.js";

function truncate(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractChildToolCopyText(
	call: CapturedToolCall | NestedCallRecord,
	full?: boolean,
): string {
	const toolName = "toolName" in call ? call.toolName : (call as { name: string }).name;
	const result = "result" in call ? (call as CapturedToolCall).result : undefined;
	const args = "args" in call ? (call as CapturedToolCall).args : undefined;

	if (toolName === "write" && isRecord(args) && typeof args.content === "string") {
		return args.content;
	}

	if (toolName === "apply_patch" && isRecord(args) && typeof args.patch === "string") {
		return args.patch;
	}

	const heavyCommand =
		toolName === "bash" && isRecord(args) && typeof args.command === "string"
			? args.command
			: (toolName === "python_eval" || toolName === "codemode") &&
					isRecord(args) &&
					typeof args.code === "string"
				? args.code
				: undefined;
	if (heavyCommand !== undefined && heavyCommand.trim() !== "") {
		if (full !== true) return heavyCommand;
		const output = resultText(result);
		return output === undefined ? heavyCommand : `${heavyCommand}\n---\n${output}`;
	}

	if (toolName === "edit" && result && isRecord(result.details)) {
		const editView = (result.details as Record<string, unknown>).__piExtToolsEditView;
		if (isRecord(editView) && Array.isArray(editView.ops)) {
			const opsText = editView.ops
				.map((op: unknown) =>
					isRecord(op) && typeof op.newContent === "string" ? op.newContent : "",
				)
				.filter(Boolean)
				.join("\n---\n");
			if (opsText) return opsText;
		}
	}

	if (result && Array.isArray(result.content)) {
		const texts = result.content
			.filter(
				(c): c is { type: "text"; text: string } =>
					isRecord(c) && c.type === "text" && typeof c.text === "string",
			)
			.map((c) => c.text);
		if (texts.length > 0) return texts.join("\n");
	}

	if (args !== undefined) {
		if (typeof args === "string") return args;
		try {
			return JSON.stringify(args, null, 2);
		} catch {
			return String(args);
		}
	}

	if ("summary" in call && typeof call.summary === "string") {
		return call.summary;
	}

	return "";
}

function resultText(result: AgentToolResult<unknown> | undefined): string | undefined {
	if (result === undefined || !Array.isArray(result.content)) return undefined;
	const texts = result.content
		.filter(
			(c): c is { type: "text"; text: string } =>
				isRecord(c) && c.type === "text" && typeof c.text === "string",
		)
		.map((c) => c.text);
	return texts.length === 0 ? undefined : texts.join("\n");
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "";
	return ms < 1000 ? `${String(Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;
}

interface LineMapEntry {
	readonly callIndex: number;
	readonly isHeader: boolean;
	readonly copyRegion?: { readonly startX: number; readonly endX: number } | undefined;
}

export interface NestedCallsViewProps {
	readonly resolvePresentation?:
		| ((toolName: string) => ToolPresentationProvider | undefined)
		| undefined;
	readonly calls: readonly (CapturedToolCall | NestedCallRecord)[];
	readonly theme: Theme;
	readonly context: ToolRenderContext;
	readonly resolveChildRenderer?: ((toolName: string) => ToolRenderers | undefined) | undefined;
	readonly copyToClipboard?: ((text: string) => Promise<void>) | undefined;
	readonly stateHolder?: Record<string, unknown> | undefined;
	readonly invalidate?: (() => void) | undefined;
}

export const NESTED_CALLS_EXPANDED_KEY = "__pi_ext_ui_nested_expanded__";
export const NESTED_CALLS_COPIED_KEY = "__pi_ext_ui_nested_copied__";

export class NestedCallsView implements Component, Collapsible {
	readonly #props: NestedCallsViewProps;
	readonly #inMemoryLevels = new Map<number, FoldLevel>();
	#copiedIndex: number | undefined = undefined;
	#copiedTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	#lineMapping: LineMapEntry[] = [];
	#renderCache:
		| {
				readonly width: number;
				readonly copiedIndex: number | undefined;
				readonly levelsKey: string;
				readonly lines: string[];
				readonly lineMapping: LineMapEntry[];
		  }
		| undefined;

	constructor(props: NestedCallsViewProps) {
		this.#props = props;
		const state = props.stateHolder;
		if (state !== undefined) {
			const stored = state[NESTED_CALLS_EXPANDED_KEY];
			if (isRecord(stored)) {
				for (const [k, v] of Object.entries(stored)) {
					const idx = Number(k);
					if (!Number.isNaN(idx) && (v === 1 || v === 2)) {
						this.#inMemoryLevels.set(idx, v);
					}
				}
			} else if (Array.isArray(stored)) {
				for (const item of stored) {
					if (typeof item === "number") {
						this.#inMemoryLevels.set(item, 1);
					}
				}
			}

			const copiedState = state[NESTED_CALLS_COPIED_KEY];
			if (
				isRecord(copiedState) &&
				typeof copiedState.index === "number" &&
				typeof copiedState.until === "number"
			) {
				const remaining = copiedState.until - Date.now();
				if (remaining > 0) {
					this.#copiedIndex = copiedState.index;
					this.#copiedTimer = setTimeout(() => {
						this.#copiedIndex = undefined;
						this.#renderCache = undefined;
						const s = this.#props.stateHolder;
						if (s !== undefined) {
							delete s[NESTED_CALLS_COPIED_KEY];
						}
						this.#props.invalidate?.();
					}, remaining);
					this.#copiedTimer.unref?.();
				} else {
					delete state[NESTED_CALLS_COPIED_KEY];
				}
			}
		}
	}

	#getExpansionLevel(index: number): FoldLevel {
		const state = this.#props.stateHolder;
		if (state !== undefined) {
			const stored = state[NESTED_CALLS_EXPANDED_KEY];
			if (isRecord(stored)) {
				const val = stored[String(index)];
				if (val === 1 || val === 2) return val;
			} else if (Array.isArray(stored)) {
				if (stored.includes(index)) return 1;
			}
		}
		return this.#inMemoryLevels.get(index) ?? 0;
	}

	#getLevelsKey(): string {
		const parts: string[] = [];
		for (let i = 0; i < this.#props.calls.length; i++) {
			const level = this.#getExpansionLevel(i);
			if (level !== 0) parts.push(`${i}:${level}`);
		}
		return parts.join(",");
	}

	#setExpansionLevel(index: number, level: FoldLevel): void {
		if (level === 0) {
			this.#inMemoryLevels.delete(index);
		} else {
			this.#inMemoryLevels.set(index, level);
		}
		this.#renderCache = undefined;
		const state = this.#props.stateHolder;
		if (state !== undefined) {
			const record: Record<string, number> = {};
			for (const [k, v] of this.#inMemoryLevels.entries()) {
				record[String(k)] = v;
			}
			state[NESTED_CALLS_EXPANDED_KEY] = record;
		}
	}

	#triggerCopy(callIndex: number, full: boolean): void {
		const call = this.#props.calls[callIndex];
		if (!call) return;
		const provider = this.#props.resolvePresentation?.(call.toolName);
		const presentation = provider?.(
			"args" in call ? call.args : undefined,
			"result" in call ? call.result : undefined,
			this.#props.theme,
		);
		const text = stripTerminalSequences(
			(full ? presentation?.copy?.full : presentation?.copy?.primary) ??
				extractChildToolCopyText(call, full),
		);
		if (!text) return;

		const writeClip = this.#props.copyToClipboard ?? copyToSystemClipboard;
		void writeClip(text).catch(() => {});

		const durationMs = 1500;
		const until = Date.now() + durationMs;
		this.#copiedIndex = callIndex;
		this.#renderCache = undefined;

		const state = this.#props.stateHolder;
		if (state !== undefined) {
			state[NESTED_CALLS_COPIED_KEY] = {
				index: callIndex,
				until,
			};
		}

		if (this.#copiedTimer !== undefined) {
			clearTimeout(this.#copiedTimer);
		}
		this.#copiedTimer = setTimeout(() => {
			this.#copiedIndex = undefined;
			this.#renderCache = undefined;
			const s = this.#props.stateHolder;
			if (s !== undefined) {
				delete s[NESTED_CALLS_COPIED_KEY];
			}
			this.#props.invalidate?.();
		}, durationMs);
		this.#copiedTimer.unref?.();

		this.#props.invalidate?.();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const levelsKey = this.#getLevelsKey();
		if (
			this.#renderCache !== undefined &&
			this.#renderCache.width === safeWidth &&
			this.#renderCache.copiedIndex === this.#copiedIndex &&
			this.#renderCache.levelsKey === levelsKey
		) {
			this.#lineMapping = this.#renderCache.lineMapping;
			return this.#renderCache.lines;
		}
		this.#lineMapping = [];
		const { calls, theme } = this.#props;
		const lines: string[] = [];
		const rightMargin = 1;

		for (let i = 0; i < calls.length; i++) {
			const call = calls[i];
			if (!call) continue;
			const toolName = "toolName" in call ? call.toolName : (call as { name: string }).name;
			const isError = Boolean(call.isError || ("status" in call && call.status === "error"));
			const isRunning =
				("status" in call && call.status === "running") ||
				(!("status" in call) && (call as CapturedToolCall).result === undefined);
			const expansionLevel = this.#getExpansionLevel(i);
			const isExpanded = expansionLevel !== 0;

			const statusGlyph = isRunning
				? theme.fg("accent", "◐")
				: isError
					? theme.fg("error", "✗")
					: theme.fg("success", "✓");

			const rawSummary = "summary" in call ? call.summary : undefined;
			const rawArgs = "args" in call ? (call as { args?: unknown }).args : undefined;
			const inline = inlinePresentation(
				toolName,
				rawArgs ?? rawSummary,
				"result" in call ? call.result?.details : undefined,
				isError,
			);

			const argText =
				typeof rawArgs === "string" ? rawArgs : typeof rawSummary === "string" ? rawSummary : "";
			const provider = this.#props.resolvePresentation?.(toolName);
			const presentation = provider?.(rawArgs, "result" in call ? call.result : undefined, theme);
			let mainText =
				presentation !== undefined
					? `${toolName} ${presentation.summary}`
					: (inline?.summary ?? (argText ? `${toolName} ${argText}` : toolName));
			mainText = stripTerminalSequences(toSingleRow(mainText));

			const duration = formatDuration(call.durationMs);
			if (duration) {
				mainText += ` ${theme.fg("dim", duration)}`;
			}

			const isCopied = this.#copiedIndex === i;
			const copyIcon = isCopied ? theme.fg("success", "✓") : theme.fg("dim", "󰆏");
			const copySlotWidth = 2 + rightMargin;

			const leftContent = `${statusGlyph} ${theme.fg("toolTitle", mainText)}`;
			const maxLeft = Math.max(1, width - copySlotWidth);
			const truncatedLeft = truncate(leftContent, maxLeft);
			const leftVis = visibleWidth(truncatedLeft);
			const gap = " ".repeat(Math.max(1, width - leftVis - rightMargin - 1));
			const headerLine = truncate(truncatedLeft + gap + copyIcon + " ".repeat(rightMargin), width);

			const headerLineIdx = lines.length;
			lines.push(headerLine);
			this.#lineMapping[headerLineIdx] = {
				callIndex: i,
				isHeader: true,
				copyRegion: { startX: width - copySlotWidth - 1, endX: width },
			};

			if (isExpanded) {
				const bodyLines = this.#renderChildBody(call, Math.max(1, width - 2), expansionLevel);
				for (const rawLine of bodyLines) {
					for (const bodyLine of toContentRows(rawLine)) {
						const bodyLineIdx = lines.length;
						lines.push(truncate(`  ${bodyLine}`, width));
						this.#lineMapping[bodyLineIdx] = {
							callIndex: i,
							isHeader: false,
						};
					}
				}
			}
		}

		this.#renderCache = {
			width: safeWidth,
			copiedIndex: this.#copiedIndex,
			levelsKey,
			lines,
			lineMapping: this.#lineMapping,
		};
		return lines;
	}

	#renderChildBody(
		call: CapturedToolCall | NestedCallRecord,
		width: number,
		expansionLevel: FoldLevel = 1,
	): string[] {
		const { theme, context, resolveChildRenderer } = this.#props;
		const toolName = "toolName" in call ? call.toolName : (call as { name: string }).name;
		const result = "result" in call ? (call as CapturedToolCall).result : undefined;
		const args = "args" in call ? (call as { args?: unknown }).args : undefined;

		if (result && resolveChildRenderer) {
			const renderer = resolveChildRenderer(toolName);
			if (renderer?.renderResult) {
				try {
					const childContext: ToolRenderContext = {
						...context,
						toolCallId: "toolCallId" in call ? (call.toolCallId as string) : context.toolCallId,
						args,
						durationMs: call.durationMs,
						isError: Boolean(call.isError || ("status" in call && call.status === "error")),
						state: undefined,
					};
					const comp = renderer.renderResult(
						result,
						{ expanded: expansionLevel === 2, isPartial: false },
						theme,
						childContext,
					);
					if (comp instanceof ToolView) {
						comp.setFoldLevel(expansionLevel);
						// Render body cleanly via deep headless interface without outer rail or header row
						return comp.renderBody(width, { noRail: true });
					}
					return comp.render(width);
				} catch {
					// Fall through to plain text extraction on renderer failure
				}
			}
		}

		// Fallback rendering
		if (result && Array.isArray(result.content)) {
			const text = result.content
				.filter(
					(c): c is { type: "text"; text: string } =>
						isRecord(c) && c.type === "text" && typeof c.text === "string",
				)
				.map((c) => c.text)
				.join("\n")
				.trim();
			if (text) {
				let lines: string[];
				const filePath =
					typeof args === "object" &&
					args !== null &&
					"path" in args &&
					typeof (args as { path: unknown }).path === "string"
						? (args as { path: string }).path
						: "";
				const lang = filePath ? getLanguageFromPath(filePath) : undefined;
				if (lang) {
					try {
						lines = highlightCode(text, lang);
					} catch {
						lines = text.split("\n");
					}
				} else {
					lines = text.split("\n");
				}
				if (expansionLevel === 2 || lines.length <= 20) {
					return lines;
				}
				return [...lines.slice(0, 20), `... (${lines.length - 20} more lines)`];
			}
		}

		if ("error" in call && typeof call.error === "string" && call.error) {
			return call.error.split("\n").map((l) => theme.fg("error", l));
		}

		if (args !== undefined) {
			const text = typeof args === "string" ? args : JSON.stringify(args, null, 2);
			return text.split("\n").map((l) => theme.fg("dim", l));
		}

		return [theme.fg("dim", "(no output)")];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const mapping = this.#lineMapping[event.y];
		if (!mapping) return { handled: true };

		if (mapping.isHeader) {
			if (mapping.copyRegion && event.x >= mapping.copyRegion.startX) {
				this.#triggerCopy(mapping.callIndex, event.shift === true);
				return { handled: true, render: true };
			}

			const isCtrl = event.ctrl === true;
			const currentLevel = this.#getExpansionLevel(mapping.callIndex);
			const nextLevel = transitionFoldLevel(currentLevel, isCtrl);
			this.#setExpansionLevel(mapping.callIndex, nextLevel);
			this.#props.invalidate?.();
			return { handled: true, render: true };
		}

		return { handled: true };
	}

	dispose(): void {
		if (this.#copiedTimer !== undefined) {
			clearTimeout(this.#copiedTimer);
			this.#copiedTimer = undefined;
		}
		this.#renderCache = undefined;
	}

	collapseAll(): void {
		if (this.#copiedTimer !== undefined) {
			clearTimeout(this.#copiedTimer);
			this.#copiedTimer = undefined;
		}
		this.#inMemoryLevels.clear();
		const state = this.#props.stateHolder;
		if (state !== undefined) {
			state[NESTED_CALLS_EXPANDED_KEY] = {};
		}
		this.#lineMapping = [];
		this.#renderCache = undefined;
	}

	invalidate(): void {
		this.#lineMapping = [];
		this.#renderCache = undefined;
	}
}
