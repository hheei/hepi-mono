import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

export const DEFAULT_DOLLAR_SKILL_MAX_SUGGESTIONS = 50;
// Dollar references are resolved against Pi's loaded skill command registry.
export const MAX_DOLLAR_SKILL_SUGGESTIONS = 50;

export interface DollarSkillCommand {
	readonly name: string;
	readonly description?: string;
	readonly source?: string;
	readonly sourceInfo?: {
		readonly path?: string;
		readonly source?: string;
		readonly scope?: string;
		readonly origin?: string;
	};
}

export interface DollarSkillConfig {
	readonly enabled: boolean;
	readonly maxSuggestions: number;
}

export const DEFAULT_DOLLAR_SKILL_CONFIG: DollarSkillConfig = {
	enabled: true,
	maxSuggestions: DEFAULT_DOLLAR_SKILL_MAX_SUGGESTIONS,
};

export interface DollarSkillToken {
	readonly query: string;
	readonly prefix: string;
}

const TOKEN_PATTERN = /(^|[\s([{])\$([A-Za-z][A-Za-z0-9-]*|)$/;
const REFERENCE_PATTERN = /(^|[\s([{])\$([A-Za-z][A-Za-z0-9-]*)(?=$|[^A-Za-z0-9:-])/g;
const ANSI_DIM = "\x1b[2m";
const ANSI_DIM_RESET = "\x1b[22m";

function dim(text: string): string {
	return `${ANSI_DIM}${text}${ANSI_DIM_RESET}`;
}

function bareSkillName(name: string): string {
	return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

function cleanDescription(description: string | undefined): string | undefined {
	const cleaned = description?.trim().replace(/^\((?:User|Project|Extension)\)\s*-\s*/i, "");
	return cleaned || undefined;
}

function sourceLabel(command: DollarSkillCommand): string {
	if (command.sourceInfo?.origin === "package") return "Extension";
	switch (command.sourceInfo?.scope) {
		case "user":
			return "User";
		case "project":
			return "Project";
		case "temporary":
			return "Temporary";
		default:
			return "Skill";
	}
}

interface SelectedSkillCommand {
	readonly command: DollarSkillCommand;
	readonly name: string;
	readonly enabled: boolean;
}

function selectSkillCommands(
	commands: readonly DollarSkillCommand[],
	isSkillEnabled: (command: DollarSkillCommand) => boolean,
): readonly SelectedSkillCommand[] {
	const selected = new Map<string, SelectedSkillCommand>();
	for (const command of commands) {
		if (command.source !== "skill") continue;
		const name = bareSkillName(command.name);
		if (!name) continue;
		const candidate = { command, name, enabled: isSkillEnabled(command) };
		const current = selected.get(name);
		if (
			current === undefined ||
			(candidate.enabled && !current.enabled) ||
			(candidate.enabled === current.enabled &&
				command.sourceInfo?.scope === "project" &&
				current.command.sourceInfo?.scope !== "project")
		)
			selected.set(name, candidate);
	}
	return [...selected.values()];
}

export function extractDollarSkillToken(
	lines: readonly string[],
	cursorLine: number,
	cursorCol: number,
): DollarSkillToken | undefined {
	const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
	const match = TOKEN_PATTERN.exec(beforeCursor);
	if (!match) return undefined;
	const delimiter = match[1] ?? "";
	const query = match[2] ?? "";
	const start = (match.index ?? 0) + delimiter.length;
	return { query, prefix: beforeCursor.slice(start) };
}

export function getDollarSkillSuggestions(
	commands: readonly DollarSkillCommand[],
	query: string,
	maxSuggestions = DEFAULT_DOLLAR_SKILL_MAX_SUGGESTIONS,
	isSkillEnabled: (command: DollarSkillCommand) => boolean = () => true,
): AutocompleteItem[] {
	const normalizedQuery = query.toLowerCase();
	const candidates: Array<{
		readonly name: string;
		readonly description: string;
		readonly enabled: boolean;
	}> = [];
	for (const { command, name, enabled } of selectSkillCommands(commands, isSkillEnabled)) {
		if (!name.toLowerCase().startsWith(normalizedQuery)) continue;
		const description = cleanDescription(command.description);
		candidates.push({
			name,
			description: description ? `${sourceLabel(command)} - ${description}` : sourceLabel(command),
			enabled,
		});
	}
	const limit = Number.isFinite(maxSuggestions)
		? Math.max(1, Math.min(MAX_DOLLAR_SKILL_SUGGESTIONS, Math.floor(maxSuggestions)))
		: DEFAULT_DOLLAR_SKILL_MAX_SUGGESTIONS;
	return candidates
		.sort(
			(left, right) =>
				Number(right.enabled) - Number(left.enabled) || left.name.localeCompare(right.name),
		)
		.slice(0, limit)
		.map(({ name, description, enabled }) => ({
			value: `$${name}`,
			label: enabled ? name : dim(name),
			description: enabled ? description : dim(description),
		}));
}

export function expandDollarSkillReferences(
	text: string,
	commands: readonly DollarSkillCommand[],
	isSkillEnabled: (command: DollarSkillCommand) => boolean = () => true,
): string | undefined {
	const paths = new Map<string, string>();
	for (const { command, name } of selectSkillCommands(commands, isSkillEnabled)) {
		if (command.sourceInfo?.path) paths.set(name, command.sourceInfo.path);
	}
	let changed = false;
	const transformed = text.replace(REFERENCE_PATTERN, (match, boundary: string, name: string) => {
		const path = paths.get(name);
		if (!path) return match;
		changed = true;
		return `${boundary}${path}`;
	});
	return changed ? transformed : undefined;
}

export function createDollarSkillAutocompleteProvider(
	current: AutocompleteProvider,
	getCommands: () => readonly DollarSkillCommand[],
	getConfig: () => DollarSkillConfig,
	isActive: () => boolean = () => true,
	isSkillEnabled: (command: DollarSkillCommand) => boolean = () => true,
): AutocompleteProvider {
	return {
		triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "$"])],
		async getSuggestions(
			lines,
			cursorLine,
			cursorCol,
			options,
		): Promise<AutocompleteSuggestions | null> {
			const config = getConfig();
			const token = extractDollarSkillToken(lines, cursorLine, cursorCol);
			if (!isActive() || !config.enabled || !token)
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const items = getDollarSkillSuggestions(
				getCommands(),
				token.query,
				config.maxSuggestions,
				isSkillEnabled,
			);
			if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { prefix: token.prefix, items };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!prefix.startsWith("$") || !item.value.startsWith("$"))
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const nextLines = [...lines];
			const line = nextLines[cursorLine] ?? "";
			const start = Math.max(0, cursorCol - prefix.length);
			const suffix = line.slice(cursorCol);
			const separator = suffix === "" || /^[A-Za-z0-9:-]/.test(suffix) ? " " : "";
			const insertion = `${item.value}${separator}`;
			nextLines[cursorLine] = `${line.slice(0, start)}${insertion}${suffix}`;
			return { lines: nextLines, cursorLine, cursorCol: start + insertion.length };
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			if (
				isActive() &&
				getConfig().enabled &&
				extractDollarSkillToken(lines, cursorLine, cursorCol)
			)
				return false;
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}
