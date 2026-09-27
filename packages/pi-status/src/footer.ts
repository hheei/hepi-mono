import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCompactNumber, type ThemeLike } from "@hheei/pi-ext-core";

type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
export type ReadonlyFooterDataProvider = Parameters<FooterFactory>[2];
export type FooterTheme = Parameters<FooterFactory>[1];

/** Formats cwd replacing HOME with ~ */
export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${sep}`) &&
			!isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Formats model identifier with provider prefix and thinking level:
 * gm/gemini-3.8-flash(high) or gm/gemini-3.8-flash
 */
export function formatFooterModel(
	model: { readonly id: string; readonly provider?: string } | undefined,
	thinkingLevel: string | undefined,
): string {
	if (model === undefined) return "no-model";
	const providerPrefix =
		model.provider !== undefined && model.provider.trim() !== "" ? `${model.provider}/` : "";
	const levelSuffix =
		thinkingLevel !== undefined && thinkingLevel !== "off" && thinkingLevel.trim() !== ""
			? `(${thinkingLevel})`
			: "";
	return `${providerPrefix}${model.id}${levelSuffix}`;
}

/**
 * Formats context usage ratio: N%/100K with warning/error colors:
 * - <= 70%: dim
 * - 70% ~ 90%: warning
 * - > 90%: error
 */
export function formatFooterContext(
	contextUsage: { readonly percent?: number | null; readonly contextWindow?: number } | undefined,
	defaultWindow: number | undefined,
	theme: ThemeLike,
): string {
	const window = contextUsage?.contextWindow ?? defaultWindow ?? 0;
	const windowStr = window > 0 ? formatCompactNumber(window) : "0";
	const percentValue = contextUsage?.percent;
	const percentStr =
		percentValue !== null && percentValue !== undefined ? `${Math.round(percentValue)}%` : "?%";
	const text = `${percentStr}/${windowStr}`;

	if (percentValue !== null && percentValue !== undefined) {
		if (percentValue > 90) return theme.fg("error", text);
		if (percentValue > 70) return theme.fg("warning", text);
	}
	return theme.fg("dim", text);
}

/**
 * Arranges a two-column row with left content aligned left and right content aligned right.
 * When constrained, shrinks/truncates or drops the right column to prioritize the left column.
 */
export function layoutTwoColumnRow(
	left: string,
	right: string | undefined,
	width: number,
	minGap = 2,
): string {
	const leftWidth = visibleWidth(left);
	if (leftWidth >= width) {
		return truncateToWidth(left, width, "");
	}
	if (right === undefined || right.trim() === "") {
		return left;
	}
	const rightWidth = visibleWidth(right);
	const totalNeeded = leftWidth + minGap + rightWidth;
	if (totalNeeded <= width) {
		const spaces = " ".repeat(width - leftWidth - rightWidth);
		return `${left}${spaces}${right}`;
	}

	// Insufficient space: truncate right side with ellipsis if at least 4 cols available
	const availableForRight = width - leftWidth - minGap;
	if (availableForRight >= 4) {
		const truncatedRight = truncateToWidth(right, availableForRight, "…");
		const truncatedWidth = visibleWidth(truncatedRight);
		const spaces = " ".repeat(Math.max(minGap, width - leftWidth - truncatedWidth));
		return `${left}${spaces}${truncatedRight}`;
	}

	// Extremely narrow: drop right side entirely to preserve full left side
	return left;
}

/**
 * Custom 2-line compact footer:
 * Line 1: path (git)                                            title
 * Line 2: provider/model(level) · N%/100K                 todo status
 */
export class CompactFooterComponent implements Component {
	readonly #extension: ExtensionContext;
	readonly #footerData: ReadonlyFooterDataProvider;
	readonly #theme: FooterTheme;
	readonly #unsubscribeBranch?: () => void;

	constructor(
		extension: ExtensionContext,
		tui: { requestRender(): void },
		theme: FooterTheme,
		footerData: ReadonlyFooterDataProvider,
	) {
		this.#extension = extension;
		this.#footerData = footerData;
		this.#theme = theme;
		this.#unsubscribeBranch = footerData.onBranchChange(() => {
			tui.requestRender();
		});
	}

	invalidate(): void {}

	dispose(): void {
		this.#unsubscribeBranch?.();
	}

	render(width: number): string[] {
		const cwd = formatCwdForFooter(this.#extension.sessionManager.getCwd(), homedir());
		const branch = this.#footerData.getGitBranch();
		const pwdWithBranch = branch !== undefined && branch !== "" ? `${cwd} (${branch})` : cwd;
		const line1Left = this.#theme.fg("dim", pwdWithBranch);

		const extensionStatuses = this.#footerData.getExtensionStatuses();
		const autoTitleStatus = extensionStatuses.get("auto-title");
		const sessionName = this.#extension.sessionManager.getSessionName();
		const line1Right =
			autoTitleStatus !== undefined && autoTitleStatus.trim() !== ""
				? autoTitleStatus
				: sessionName !== undefined && sessionName.trim() !== ""
					? this.#theme.fg("dim", sessionName)
					: undefined;

		const line1 = layoutTwoColumnRow(line1Left, line1Right, width);

		// Line 2 left: model + thinking level · context%
		const modelText = formatFooterModel(this.#extension.model, this.#extension.thinkingLevel);
		const contextText = formatFooterContext(
			this.#extension.getContextUsage(),
			this.#extension.model?.contextWindow,
			this.#theme,
		);
		const line2Left = `${this.#theme.fg("dim", modelText)} ${this.#theme.fg("dim", "·")} ${contextText}`;

		// Line 2 right: todo status or extension statuses (excluding auto-title which belongs to line 1)
		let todoStatus = extensionStatuses.get("pi-ext-tools:todo");
		if (todoStatus === undefined && extensionStatuses.size > 0) {
			for (const [key, value] of extensionStatuses) {
				if (key !== "auto-title" && value.trim() !== "") {
					todoStatus = value;
					break;
				}
			}
		}

		const line2 = layoutTwoColumnRow(line2Left, todoStatus, width);

		return [line1, line2];
	}
}
