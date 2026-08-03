import type { TUI } from "@earendil-works/pi-tui";

export interface ToolResultBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface ToolResultLayout {
	readonly tui: TUI;
	readonly bounds: ToolResultBounds | undefined;
	onChange(listener: (bounds: ToolResultBounds | undefined) => void): () => void;
}

type HostLayout = {
	readonly tui: TUI;
	readonly bounds?: unknown;
	readonly onChange: (listener: (bounds: unknown) => void) => unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTui(value: unknown): value is TUI {
	return (
		isRecord(value) &&
		isRecord(value.terminal) &&
		typeof value.terminal.write === "function" &&
		typeof value.addInputListener === "function" &&
		typeof value.requestRender === "function"
	);
}

function isHostLayout(value: unknown): value is HostLayout {
	return isRecord(value) && isTui(value.tui) && typeof value.onChange === "function";
}

function normalizeBounds(value: unknown): ToolResultBounds | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.x !== "number" ||
		typeof value.y !== "number" ||
		typeof value.width !== "number" ||
		typeof value.height !== "number" ||
		!Number.isSafeInteger(value.x) ||
		!Number.isSafeInteger(value.y) ||
		!Number.isSafeInteger(value.width) ||
		!Number.isSafeInteger(value.height) ||
		value.width < 0 ||
		value.height < 0
	)
		return undefined;
	return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function readHostLayout(context: unknown): HostLayout | undefined {
	if (!isRecord(context)) return undefined;
	try {
		const layout = context.resultLayout;
		return isHostLayout(layout) ? layout : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Reads an optional host capability without making Pi layout patches a published
 * dependency. Absent or malformed hosts must leave consumers on their upstream renderer.
 */
export function getToolResultLayout(context: unknown): ToolResultLayout | undefined {
	const host = readHostLayout(context);
	if (host === undefined) return undefined;
	return {
		tui: host.tui,
		bounds: normalizeBounds(host.bounds),
		onChange(listener): () => void {
			let dispose: unknown;
			try {
				dispose = host.onChange((bounds) => listener(normalizeBounds(bounds)));
			} catch {
				return (): void => {};
			}
			let disposed = false;
			return (): void => {
				if (disposed) return;
				disposed = true;
				if (typeof dispose === "function") dispose();
			};
		},
	};
}
