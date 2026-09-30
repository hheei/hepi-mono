import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { fitRow, formatCompactNumber, type ThemeLike } from "@hheei/pi-ext-core";

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
 * - When theme is provided:
 *   [provider/ (dim)][modelId (text)][(thinking) ((dim) + (accent) + (dim))]
 * - When theme is omitted:
 *   gm/gemini-3.8-flash(high) or gm/gemini-3.8-flash
 */
export function formatFooterModel(
	model: { readonly id: string; readonly provider?: string } | undefined,
	thinkingLevel: string | undefined,
	theme?: ThemeLike,
): string {
	if (model === undefined) return theme !== undefined ? theme.fg("dim", "no-model") : "no-model";
	const hasProvider = model.provider !== undefined && model.provider.trim() !== "";
	const providerText = hasProvider ? `${model.provider}/` : "";
	const hasThinking =
		thinkingLevel !== undefined && thinkingLevel !== "off" && thinkingLevel.trim() !== "";

	if (theme === undefined) {
		const levelSuffix = hasThinking ? `(${thinkingLevel})` : "";
		return `${providerText}${model.id}${levelSuffix}`;
	}

	const providerPart = hasProvider ? theme.fg("dim", providerText) : "";
	const modelPart = theme.fg("text", model.id);
	const thinkingPart = hasThinking
		? `${theme.fg("dim", "(")}${theme.fg("accent", thinkingLevel)}${theme.fg("dim", ")")}`
		: "";
	return `${providerPart}${modelPart}${thinkingPart}`;
}

/**
 * Formats context usage ratio: N%/100K with warning/error colors:
 * - <= 70%: [N% (muted)][/100K (dim)]
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

	if (percentValue !== null && percentValue !== undefined) {
		if (percentValue > 90) return theme.fg("error", `${percentStr}/${windowStr}`);
		if (percentValue > 70) return theme.fg("warning", `${percentStr}/${windowStr}`);
	}
	return `${theme.fg("muted", percentStr)}${theme.fg("dim", `/${windowStr}`)}`;
}

/**
 * Formats cwd and optional git branch for footer display:
 * [path (muted)] [( (dim)][branch (accent)][) (dim)]
 */
export function formatFooterPath(
	cwd: string,
	branch: string | null | undefined,
	theme: ThemeLike,
	home?: string,
): string {
	const formattedCwd = formatCwdForFooter(cwd, home);
	const cwdPart = theme.fg("muted", formattedCwd);
	if (branch === null || branch === undefined || branch.trim() === "") {
		return cwdPart;
	}
	const branchPart = `${theme.fg("dim", "(")}${theme.fg("accent", branch)}${theme.fg("dim", ")")}`;
	return `${cwdPart} ${branchPart}`;
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
		return fitRow(left, width, "");
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
		const truncatedRight = fitRow(right, availableForRight, "…");
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
		const cwd = this.#extension.sessionManager.getCwd();
		const branch = this.#footerData.getGitBranch();
		const line1Left = formatFooterPath(cwd, branch, this.#theme, homedir());

		const extensionStatuses = this.#footerData.getExtensionStatuses();
		const autoTitleStatus = extensionStatuses.get("auto-title");
		const sessionName = this.#extension.sessionManager.getSessionName();
		const line1Right =
			autoTitleStatus !== undefined && autoTitleStatus.trim() !== ""
				? autoTitleStatus
				: sessionName !== undefined && sessionName.trim() !== ""
					? this.#theme.fg("muted", sessionName)
					: undefined;

		const line1 = layoutTwoColumnRow(line1Left, line1Right, width);

		// Line 2 left: model + thinking level · context%
		const modelPart = formatFooterModel(
			this.#extension.model,
			this.#extension.thinkingLevel,
			this.#theme,
		);
		const contextPart = formatFooterContext(
			this.#extension.getContextUsage(),
			this.#extension.model?.contextWindow,
			this.#theme,
		);
		const line2Left = `${modelPart} ${this.#theme.fg("dim", "·")} ${contextPart}`;

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
