import { truncateToWidth } from "@earendil-works/pi-tui";
import { renderRowsWithSidePanel } from "@hheei/pi-extcore";

export type LoadoutFooterPane = "tools" | "skills";
export type LoadoutFooterSelectionKind = "toolGroup" | "skillGroup" | "tool" | "skill" | "preset";

export interface LoadoutFooterTheme {
	dim(text: string): string;
	key(text: string): string;
}

export interface LoadoutFooterOptions {
	pane: LoadoutFooterPane;
	selectedIndex: number;
	total: number;
	selectedDescription?: string;
	selectedSpaceAction?: "enable" | "disable";
	selectedKind?: LoadoutFooterSelectionKind;
	selectedGroupCollapsed?: boolean;
	width: number;
	theme: LoadoutFooterTheme;
}
export type LoadoutStatus = "enabled" | "disabled" | "partial";

export function loadoutStatusSymbol(status: LoadoutStatus): "●" | "○" | "◐" {
	if (status === "enabled") return "●";
	if (status === "disabled") return "○";
	return "◐";
}

export function formatLoadoutStatusLabel(
	prefix: string,
	status: LoadoutStatus,
	label: string,
): string {
	return `${prefix}${loadoutStatusSymbol(status)} ${label}`;
}

export function formatLoadoutGroupDescription(
	label: string,
	enabledCount: number,
	totalCount: number,
): string {
	return `${label} · ${enabledCount}/${totalCount} enabled`;
}

export function stripSettingsListExtraLines(lines: readonly string[]): string[] {
	const extrasStart = lines.findIndex(isSettingsListExtraLine);
	return extrasStart === -1 ? [...lines] : lines.slice(0, extrasStart);
}

export function createLoadoutFooterLines(options: LoadoutFooterOptions): string[] {
	const { theme, width } = options;
	const status = options.total === 0 ? "(0/0)" : `(${options.selectedIndex + 1}/${options.total})`;
	const infoParts = [theme.dim(`  ${status}`)];
	if (options.selectedDescription) infoParts.push(theme.dim(` · ${options.selectedDescription}`));

	const actionParts = [theme.key("Tab"), theme.dim(" switch")];

	actionParts.push(
		theme.dim(" · "),
		theme.key("Space"),
		theme.dim(` ${options.selectedSpaceAction ?? "enable"}`),
	);
	const groupFocused =
		options.selectedKind === "toolGroup" || options.selectedKind === "skillGroup";
	if (groupFocused) {
		actionParts.push(
			theme.dim(" · "),
			theme.key("Enter"),
			theme.dim(options.selectedGroupCollapsed ? " expand" : " collapse"),
		);
	}
	actionParts.push(theme.dim(" · "), theme.key("Esc"), theme.dim(" close"));

	if (groupFocused) {
		return [
			truncateToWidth(infoParts.join(""), width),
			truncateToWidth(`  ${actionParts.join("")}`, width),
		];
	}

	return [truncateToWidth(`${infoParts.join("")} · ${actionParts.join("")}`, width)];
}
export interface LoadoutDescriptionTheme {
	title(text: string): string;
}

export function mergeRowsWithDescription(
	rows: readonly string[],
	description: string | undefined,
	width: number,
	theme: LoadoutDescriptionTheme,
): string[] {
	return renderRowsWithSidePanel({
		rows,
		width,
		title: "Description",
		content: description,
		theme,
	});
}

function isSettingsListExtraLine(line: string): boolean {
	const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
	const plain = line.replace(ansiPattern, "").trim();
	return plain === "" || /^\(\d+\/\d+\)$/.test(plain) || plain.includes("Space to change");
}
