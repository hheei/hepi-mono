export interface SplitLayout {
	readonly width: number;
	readonly mode: "split" | "stacked";
	readonly leftWidth: number;
	readonly rightWidth: number;
	readonly gap: number;
}

export interface SplitLayoutOptions {
	readonly width: number;
	readonly breakpoint?: number;
	readonly gap?: number;
	readonly leftMin?: number;
	readonly leftMax?: number;
	readonly rightMin?: number;
	readonly rightMax?: number;
	readonly leftRatio?: number;
}

/** Shared responsive rule for list/controls with an optional detail panel. */
export function createSplitLayout(options: SplitLayoutOptions): SplitLayout {
	const width = Math.max(0, Math.floor(options.width));
	const breakpoint = options.breakpoint ?? 75;
	const gap = Math.max(0, Math.floor(options.gap ?? 3));
	const leftMin = Math.max(0, Math.floor(options.leftMin ?? 24));
	const leftMax = Math.max(leftMin, Math.floor(options.leftMax ?? 40));
	const rightMin = Math.max(0, Math.floor(options.rightMin ?? 32));
	const minimumSplitWidth = leftMin + gap + rightMin;
	if (width < Math.max(breakpoint, minimumSplitWidth))
		return { width, mode: "stacked", leftWidth: width, rightWidth: 0, gap: 0 };
	const rightMax = Math.max(rightMin, Math.floor(options.rightMax ?? 44));
	const available = Math.max(0, width - gap);
	const preferredLeft = Math.floor(available * (options.leftRatio ?? 0.58));
	const leftWidth = Math.min(
		leftMax,
		Math.max(leftMin, Math.min(preferredLeft, Math.max(leftMin, available - rightMin))),
	);
	const rightWidth = Math.min(rightMax, available - leftWidth);
	return { width, mode: "split", leftWidth, rightWidth, gap };
}
