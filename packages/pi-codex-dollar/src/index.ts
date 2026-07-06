import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	registerExtensionSettings,
	type SettingGroup,
	type SettingsState,
} from "@hheei/pi-extcore";

const MAX_SUGGESTIONS = 30;
const DOLLAR_TOKEN_PATTERN = /(^|[\s([{])\$([A-Za-z0-9-]*)$/;
const DOLLAR_REFERENCE_PATTERN = /(^|[\s([{])\$([A-Za-z0-9-]+)(?![A-Za-z0-9-:])/g;
const CYAN = "\x1b[36m";
const RESET_FG = "\x1b[39m";
const HIGHLIGHT_WRAPPED = Symbol.for("pi-codex-dollar.highlightWrapped");
const HIGHLIGHT_WRAPPED_VERSION = Symbol.for("pi-codex-dollar.highlightWrappedVersion");
const HIGHLIGHT_BASE_EDITOR = Symbol.for("pi-codex-dollar.highlightBaseEditor");
const WRAPPER_VERSION = "2026-07-05-package-source-fallback";
const LOADOUT_STATE_CUSTOM_TYPE = "pi-loadout:selection";
const GLOBAL_LOADOUT_PATH = join(homedir(), ".pi", "agent", "loadout.json");

type DollarExtensionSettings = {
	pickerEnabled: boolean;
	maxSuggestions: number;
	expandReferences: boolean;
	highlightReferences: boolean;
	respectLoadout: boolean;
};

const DEFAULT_DOLLAR_SETTINGS: DollarExtensionSettings = {
	pickerEnabled: true,
	maxSuggestions: MAX_SUGGESTIONS,
	expandReferences: true,
	highlightReferences: true,
	respectLoadout: true,
};

const DOLLAR_SETTING_GROUPS: SettingGroup[] = [
	{
		id: "general",
		title: "General",
		display: "plain",
		fields: [
			{
				id: "pickerEnabled",
				label: "Inline picker",
				defaultValue: DEFAULT_DOLLAR_SETTINGS.pickerEnabled,
				description: "Show skill suggestions after typing $ in the TUI editor",
			},
			{
				id: "maxSuggestions",
				label: "Suggestion limit",
				defaultValue: DEFAULT_DOLLAR_SETTINGS.maxSuggestions,
				description: "Maximum number of $skill suggestions shown by the inline picker",
				options: [10, 20, 30, 50].map((value) => ({ value, label: String(value) })),
			},
			{
				id: "expandReferences",
				label: "Expand references",
				defaultValue: DEFAULT_DOLLAR_SETTINGS.expandReferences,
				description: "Replace $skill references with SKILL.md paths before user input is submitted",
			},
			{
				id: "highlightReferences",
				label: "Highlight references",
				defaultValue: DEFAULT_DOLLAR_SETTINGS.highlightReferences,
				description: "Highlight valid $skill references while rendering editor text",
			},
			{
				id: "respectLoadout",
				label: "Respect loadout",
				defaultValue: DEFAULT_DOLLAR_SETTINGS.respectLoadout,
				description: "Rank enabled pi-loadout skills ahead of inactive skills",
			},
		],
	},
];
type SelectListTheme = {
	description?: (text: string) => string;
	scrollInfo?: (text: string) => string;
	selectedText?: (text: string) => string;
};

type DollarTheme = {
	fg?: (key: string, text: string) => string;
	selectList?: SelectListTheme;
	description?: (text: string) => string;
	scrollInfo?: (text: string) => string;
	selectedText?: (text: string) => string;
};

type SkillSourceInfo = {
	path?: string;
	baseDir?: string;
	source?: string;
	origin?: string;
	scope?: string;
};

type SkillCommand = {
	name: string;
	description?: string;
	source?: string;
	sourceInfo?: SkillSourceInfo;
};

type SkillEntry = {
	index: number;
	name: string;
	normalizedName: string;
	source: string;
	description: string;
	value: string;
};

export type SkillSuggestion = {
	value: string;
	label: string;
	description: string;
	active?: boolean;
};

type DollarSkillToken = {
	query: string;
	prefix: string;
};

type EditorCursor = { line: number; col: number };

type EditorLike = {
	getLines(): string[];
	getCursor(): EditorCursor;
	handleInput(data: string): void;
	render(width: number): string[];
	insertTextAtCursor?: (text: string) => void;
};

type SymbolMetadata = Record<symbol, unknown>;

type TuiLike = {
	height?: number;
	rows?: number;
	terminal?: { height?: number; rows?: number };
	requestRender?: () => void;
};

type KeybindingsLike = {
	matches?: (data: string, action: string) => boolean;
};

type CustomEditorConstructor = new (
	tui: TuiLike,
	theme: DollarTheme,
	keybindings: KeybindingsLike | undefined,
) => EditorLike;

type PickerState = {
	token: DollarSkillToken;
	items: SkillSuggestion[];
};

type LoadoutState = { enabledSkills?: unknown };
type BranchEntry = { type?: string; customType?: string; data?: unknown };

let globalLoadoutCache: { mtimeMs: number; activeSkillNames: Set<string> | undefined } | undefined;

function normalize(value: unknown): string {
	return String(value ?? "").toLowerCase();
}

function bareSkillName(commandName: unknown): string {
	const name = String(commandName ?? "");
	return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

function padRight(text: string, width: number): string {
	if (text.length >= width) return text;
	return text + " ".repeat(width - text.length);
}

function truncate(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	if (width <= 1) return text.slice(0, width);
	return `${text.slice(0, width - 1)}…`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

function styleSelectList(
	theme: DollarTheme | undefined,
): SelectListTheme | DollarTheme | undefined {
	return theme?.selectList ?? theme;
}

function styleDescription(text: string | undefined, theme?: DollarTheme): string {
	if (!text) return text ?? "";
	const selectList = styleSelectList(theme);
	return typeof selectList?.description === "function" ? selectList.description(text) : text;
}

function styleScrollInfo(text: string | undefined, theme?: DollarTheme): string {
	if (!text) return text ?? "";
	const selectList = styleSelectList(theme);
	return typeof selectList?.scrollInfo === "function" ? selectList.scrollInfo(text) : text;
}

function styleSelectedRow(text: string, theme?: DollarTheme): string {
	if (!text) return text;
	const selectList = styleSelectList(theme);
	return typeof selectList?.selectedText === "function"
		? selectList.selectedText(text)
		: `${CYAN}${text}${RESET_FG}`;
}

function styleInactiveRow(text: string, theme?: DollarTheme): string {
	return styleDescription(text, theme);
}

function themeFgFirst(
	theme: DollarTheme | undefined,
	keys: string[],
	text: string,
): string | undefined {
	if (!theme?.fg || !text) return undefined;

	for (const key of keys) {
		try {
			const styled = theme.fg(key, text);
			if (styled && styled !== text) return styled;
		} catch {
			// Unknown theme keys are optional.
		}
	}

	return undefined;
}

function highlightAccent(text: string, theme?: DollarTheme): string {
	if (!text) return text;
	return (
		themeFgFirst(
			theme,
			["codexDollarHighlight", "codexDollarSelected", "mdCode", "syntaxType", "toolTitle"],
			text,
		) ?? styleSelectedRow(text, theme)
	);
}

function wrapText(text: unknown, width: number): string[] {
	if (width <= 0) return [""];
	const normalized = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) return [""];

	const lines = [];
	let current = "";

	for (const word of normalized.split(" ")) {
		if (word.length > width) {
			if (current) {
				lines.push(current);
				current = "";
			}
			for (let i = 0; i < word.length; i += width) {
				lines.push(word.slice(i, i + width));
			}
			continue;
		}

		const next = current ? `${current} ${word}` : word;
		if (next.length <= width) {
			current = next;
		} else {
			if (current) lines.push(current);
			current = word;
		}
	}

	if (current) lines.push(current);
	return lines.length > 0 ? lines : [""];
}
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const packageSkillIndexes = new Map<string, Map<string, string>>();
const skillEntriesCache = new WeakMap<readonly SkillCommand[], SkillEntry[]>();
const skillPathMapCache = new WeakMap<readonly SkillCommand[], Map<string, string>>();

function normalizeSourceLabel(label: unknown): string | undefined {
	const text = String(label ?? "").trim();
	if (!text) return undefined;
	return text.slice(0, 1).toUpperCase() + text.slice(1).toLowerCase();
}

function packageNpmRoots(): string[] {
	const roots = new Set<string>();
	const envRoots = String(
		process.env.PI_CODEX_DOLLAR_NPM_ROOTS ?? process.env.CODEX_DOLLAR_AUTCOMPLETE_NPM_ROOTS ?? "",
	)
		.split(delimiter)
		.map((root) => root.trim())
		.filter(Boolean);

	for (const root of envRoots) roots.add(resolve(root));
	roots.add(resolve(process.cwd(), "npm/node_modules"));
	roots.add(resolve(homedir(), ".pi/agent/npm/node_modules"));
	roots.add(resolve(EXTENSION_DIR, "../../..", "npm/node_modules"));

	const installedPackageRoot = resolve(EXTENSION_DIR, "../../..");
	if (basename(installedPackageRoot) === "node_modules") roots.add(installedPackageRoot);

	return [...roots];
}

function packageDirs(root: string): string[] {
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}

	const dirs: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;

		const entryPath = join(root, entry.name);
		if (entry.name.startsWith("@")) {
			let scopedEntries: Dirent<string>[];
			try {
				scopedEntries = readdirSync(entryPath, { withFileTypes: true });
			} catch {
				continue;
			}

			for (const scopedEntry of scopedEntries) {
				if (scopedEntry.isDirectory()) dirs.push(join(entryPath, scopedEntry.name));
			}
		} else {
			dirs.push(entryPath);
		}
	}

	return dirs;
}

function packageSkillIndex(): Map<string, string> {
	const cacheKey =
		process.env.PI_CODEX_DOLLAR_NPM_ROOTS ?? process.env.CODEX_DOLLAR_AUTCOMPLETE_NPM_ROOTS ?? "";
	const cached = packageSkillIndexes.get(cacheKey);
	if (cached) return cached;

	const index = new Map<string, string>();
	for (const root of packageNpmRoots()) {
		for (const packageDir of packageDirs(root)) {
			let skillEntries: Dirent<string>[];
			try {
				skillEntries = readdirSync(join(packageDir, "skills"), { withFileTypes: true });
			} catch {
				continue;
			}

			for (const skillEntry of skillEntries) {
				if (!skillEntry.isDirectory()) continue;
				const skillName = skillEntry.name;
				if (index.has(skillName)) continue;

				const candidate = join(packageDir, "skills", skillName, "SKILL.md");
				if (existsSync(candidate)) index.set(skillName, candidate);
			}
		}
	}

	packageSkillIndexes.set(cacheKey, index);
	return index;
}

function packageSkillPath(skillName: unknown): string | undefined {
	const normalizedName = String(skillName ?? "").replace(/[\\/]/g, "");
	if (!normalizedName) return undefined;
	return packageSkillIndex().get(normalizedName);
}

function normalizeSkillDescription(description: unknown): {
	source: string | undefined;
	description: string;
} {
	const text = String(description ?? "").trim();
	const match = text.match(/^\((User|Project|Extension)\)\s*-\s*(.*)$/i);
	if (!match) return { source: undefined, description: text };

	return { source: normalizeSourceLabel(match[1]), description: match[2] ?? "" };
}

function formatSourceLabel(
	sourceInfo: SkillSourceInfo | undefined,
	sourceHint: string | undefined,
	skillName: string,
): string {
	const provenance = [sourceInfo?.path, sourceInfo?.baseDir, sourceInfo?.source]
		.filter(Boolean)
		.join(" ");
	const hasConcretePath = Boolean(sourceInfo?.path || sourceInfo?.baseDir);

	if (sourceInfo?.origin === "package") return "Extension";
	if (/\bnode_modules\b/.test(provenance) || /^npm:/.test(String(sourceInfo?.source ?? "")))
		return "Extension";
	if (hasConcretePath && sourceInfo?.scope === "user") return "User";
	if (hasConcretePath && sourceInfo?.scope === "project") return "Project";
	if (sourceHint === "Extension") return "Extension";
	if (packageSkillPath(skillName)) return "Extension";
	if (sourceInfo?.scope === "user") return "User";
	if (sourceInfo?.scope === "project") return "Project";
	if (sourceHint) return sourceHint;

	const fallback = sourceInfo?.scope ?? sourceInfo?.origin ?? sourceInfo?.source ?? "unknown";
	return normalizeSourceLabel(fallback) ?? "Unknown";
}

function getSkillEntries(commands: readonly SkillCommand[]): SkillEntry[] {
	const cached = skillEntriesCache.get(commands);
	if (cached) return cached;

	const entries = commands
		.filter((command) => command?.source === "skill" && command.name)
		.map((command, index) => {
			const normalizedDescription = normalizeSkillDescription(command.description);
			const name = bareSkillName(command.name);

			return {
				index,
				name,
				normalizedName: normalize(name),
				source: formatSourceLabel(command.sourceInfo, normalizedDescription.source, name),
				description: normalizedDescription.description,
				value: `$${name}`,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name) || a.index - b.index);

	skillEntriesCache.set(commands, entries);
	return entries;
}

function formatSkillItem(entry: SkillEntry, active = true): SkillSuggestion {
	return {
		value: entry.value,
		label: entry.name,
		description: entry.description
			? `(${entry.source}) - ${entry.description}`
			: `(${entry.source})`,
		active,
	};
}

function getSkillPathMap(commands: readonly SkillCommand[]): Map<string, string> {
	const cached = skillPathMapCache.get(commands);
	if (cached) return cached;

	const skills = new Map<string, string>();

	for (const command of commands) {
		if (command?.source !== "skill" || !command.name) continue;
		const skillName = bareSkillName(command.name);
		const skillPath = command.sourceInfo?.path ?? packageSkillPath(skillName);
		if (!skillPath || skills.has(skillName)) continue;
		skills.set(skillName, skillPath);
	}

	skillPathMapCache.set(commands, skills);
	return skills;
}

export function extractDollarSkillToken(
	lines: readonly string[],
	cursorLine: number,
	cursorCol: number,
): DollarSkillToken | null {
	const currentLine = lines[cursorLine] ?? "";
	const beforeCursor = currentLine.slice(0, cursorCol);
	const match = beforeCursor.match(DOLLAR_TOKEN_PATTERN);
	if (!match) return null;

	const delimiter = match[1] ?? "";
	const query = match[2] ?? "";
	if (/^\d+$/.test(query)) return null;
	const tokenStartCol = (match.index ?? 0) + delimiter.length;

	return {
		query,
		prefix: beforeCursor.slice(tokenStartCol),
	};
}

export function getSkillSuggestions(
	commands: readonly SkillCommand[],
	query: string,
	maxSuggestions = MAX_SUGGESTIONS,
	activeSkillNames?: ReadonlySet<string>,
): SkillSuggestion[] {
	const normalizedQuery = normalize(query).trim();
	const active = [];
	const inactive = [];

	for (const entry of getSkillEntries(commands)) {
		if (normalizedQuery && !entry.normalizedName.startsWith(normalizedQuery)) continue;
		if (activeSkillNames && !activeSkillNames.has(entry.name)) inactive.push(entry);
		else active.push(entry);
	}

	return [...active, ...inactive]
		.slice(0, maxSuggestions)
		.map((entry) => formatSkillItem(entry, !activeSkillNames || activeSkillNames.has(entry.name)));
}

export function applyDollarSkillCompletion(
	lines: readonly string[],
	cursorLine: number,
	cursorCol: number,
	item: SkillSuggestion,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const nextLines = [...lines];
	const line = nextLines[cursorLine] ?? "";
	const startCol = Math.max(0, cursorCol - prefix.length);
	const insertion = item.value;

	nextLines[cursorLine] = `${line.slice(0, startCol)}${insertion}${line.slice(cursorCol)}`;

	return {
		lines: nextLines,
		cursorLine,
		cursorCol: startCol + insertion.length,
	};
}

export function expandDollarSkillReferences(
	text: string,
	commands: readonly SkillCommand[],
): string | null {
	let skills: Map<string, string> | undefined;
	let changed = false;

	const transformed = text.replace(DOLLAR_REFERENCE_PATTERN, (match, delimiter, rawName) => {
		skills ??= getSkillPathMap(commands);
		const skillPath = skills.get(rawName);
		if (!skillPath) return match;

		changed = true;
		return `${delimiter}${skillPath}`;
	});

	return changed ? transformed : null;
}

export function highlightDollarSkillReferences(
	text: string,
	commands: readonly SkillCommand[],
	theme?: DollarTheme,
): string {
	let skills: Map<string, string> | undefined;

	return text.replace(DOLLAR_REFERENCE_PATTERN, (match, delimiter, rawName) => {
		skills ??= getSkillPathMap(commands);
		if (!skills.has(rawName)) return match;

		return `${delimiter}${highlightAccent(`$${rawName}`, theme)}`;
	});
}

export function renderSkillPickerLines(
	items: readonly SkillSuggestion[],
	selectedIndex: number,
	width: number,
	theme?: DollarTheme,
	maxLines?: number,
): string[] {
	if (items.length === 0) return [];

	const prefixWidth = 2;
	const gap = 2;
	const rawNameWidth = Math.max(1, ...items.map((item) => item.label.length));
	const nameWidth = clamp(rawNameWidth, 8, Math.max(8, Math.min(24, Math.floor(width * 0.25))));
	const sourceWidth = 9;
	const descWidth = Math.max(12, width - prefixWidth - nameWidth - sourceWidth - gap * 2);
	const continuationIndent = " ".repeat(prefixWidth + nameWidth + gap + sourceWidth + gap);
	const groups: string[][] = [];
	let selectedStart = 0;
	let selectedEnd = 0;
	let lineCount = 0;

	items.forEach((item, index) => {
		const sourceMatch = item.description?.match(/^\(([^)]+)\)(?: - )?(.*)$/);
		const source = sourceMatch?.[1] ?? "Unknown";
		const description = sourceMatch?.[2] ?? item.description ?? "";
		const descriptionLines = wrapText(description, descWidth);
		const selected = index === selectedIndex;
		const active = item.active !== false;
		const prefix = selected ? "→ " : "  ";
		const name = truncate(item.label, nameWidth);
		const sourceLabel = truncate(source, sourceWidth);
		const firstDescription = descriptionLines[0] ?? "";
		const row = `${prefix}${padRight(name, nameWidth)}${" ".repeat(gap)}${padRight(sourceLabel, sourceWidth)}${" ".repeat(gap)}${
			active && !selected ? styleDescription(firstDescription, theme) : firstDescription
		}`;
		const group = [
			active ? (selected ? styleSelectedRow(row, theme) : row) : styleInactiveRow(row, theme),
		];

		for (const extraLine of descriptionLines.slice(1)) {
			const row = `${continuationIndent}${extraLine}`;
			if (!active) group.push(styleInactiveRow(row, theme));
			else
				group.push(
					selected
						? styleSelectedRow(row, theme)
						: `${continuationIndent}${styleDescription(extraLine, theme)}`,
				);
		}

		if (selected) {
			selectedStart = lineCount;
			selectedEnd = lineCount + group.length - 1;
		}

		groups.push(group);
		lineCount += group.length;
	});

	const lines = groups.flat();
	const limit =
		typeof maxLines === "number" && Number.isFinite(maxLines)
			? Math.max(1, Math.floor(maxLines))
			: undefined;
	if (!limit || lines.length <= limit) return lines;

	const includeScrollInfo = items.length > 1;
	const visibleLimit = includeScrollInfo ? Math.max(1, limit - 1) : limit;
	const start = clamp(
		selectedStart - Math.floor((visibleLimit - 1) / 2),
		0,
		Math.max(0, lines.length - visibleLimit),
	);
	const end = Math.max(start + visibleLimit, selectedEnd + 1);
	const visibleLines = lines.slice(start, Math.min(lines.length, end)).slice(0, visibleLimit);

	if (includeScrollInfo) {
		visibleLines.push(styleScrollInfo(`  (${selectedIndex + 1}/${items.length})`, theme));
	}

	return visibleLines;
}
function parseLoadoutActiveSkillNames(value: unknown): Set<string> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const enabledSkills = (value as LoadoutState).enabledSkills;
	if (!Array.isArray(enabledSkills)) return undefined;
	return new Set(enabledSkills.filter((name) => typeof name === "string"));
}

function latestBranchLoadoutActiveSkillNames(ctx: ExtensionContext): Set<string> | undefined {
	const getBranch = ctx?.sessionManager?.getBranch;
	if (typeof getBranch !== "function") return undefined;

	let entries: unknown;
	try {
		entries = getBranch.call(ctx.sessionManager);
	} catch {
		return undefined;
	}

	if (!Array.isArray(entries)) return undefined;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i] as BranchEntry | undefined;
		if (entry?.type !== "custom" || entry.customType !== LOADOUT_STATE_CUSTOM_TYPE) continue;
		return parseLoadoutActiveSkillNames(entry.data);
	}

	return undefined;
}

function globalLoadoutActiveSkillNames() {
	try {
		const stats = statSync(GLOBAL_LOADOUT_PATH);
		if (globalLoadoutCache?.mtimeMs === stats.mtimeMs) return globalLoadoutCache.activeSkillNames;

		const activeSkillNames = parseLoadoutActiveSkillNames(
			JSON.parse(readFileSync(GLOBAL_LOADOUT_PATH, "utf8")),
		);
		globalLoadoutCache = { mtimeMs: stats.mtimeMs, activeSkillNames };
		return activeSkillNames;
	} catch {
		globalLoadoutCache = undefined;
		return undefined;
	}
}

function loadoutActiveSkillNames(ctx: ExtensionContext): Set<string> | undefined {
	return latestBranchLoadoutActiveSkillNames(ctx) ?? globalLoadoutActiveSkillNames();
}

function dollarSettingsFromState(state: SettingsState | undefined): DollarExtensionSettings {
	const general = state?.general ?? {};
	return {
		pickerEnabled: general.pickerEnabled !== false,
		maxSuggestions:
			typeof general.maxSuggestions === "number" ? general.maxSuggestions : MAX_SUGGESTIONS,
		expandReferences: general.expandReferences !== false,
		highlightReferences: general.highlightReferences !== false,
		respectLoadout: general.respectLoadout !== false,
	};
}

function getPickerState(
	baseEditor: EditorLike,
	commands: readonly SkillCommand[],
	maxSuggestions: number,
	activeSkillNames?: ReadonlySet<string>,
): PickerState | null {
	if (typeof baseEditor.getLines !== "function" || typeof baseEditor.getCursor !== "function")
		return null;
	const cursor = baseEditor.getCursor();
	const token = extractDollarSkillToken(baseEditor.getLines(), cursor.line, cursor.col);
	if (!token) return null;

	const items = getSkillSuggestions(commands, token.query, maxSuggestions, activeSkillNames);
	if (items.length === 0) return null;

	return { token, items };
}

export function createSkillPickerEditor(
	baseEditor: EditorLike,
	getCommands: () => readonly SkillCommand[],
	theme: DollarTheme,
	tui: TuiLike,
	keybindings?: KeybindingsLike,
	getSettings?: () => DollarExtensionSettings,
	getActiveSkillNames?: () => ReadonlySet<string> | undefined,
): EditorLike {
	const editorMetadata = baseEditor as unknown as SymbolMetadata;
	if (
		editorMetadata[HIGHLIGHT_WRAPPED] &&
		editorMetadata[HIGHLIGHT_WRAPPED_VERSION] === WRAPPER_VERSION
	)
		return baseEditor;
	const unwrappedEditor = editorMetadata[HIGHLIGHT_BASE_EDITOR];
	if (editorMetadata[HIGHLIGHT_WRAPPED] && isEditorLike(unwrappedEditor))
		baseEditor = unwrappedEditor;

	const state: { selectedIndex: number; lastPrefix?: string; closedPrefix?: string } = {
		selectedIndex: 0,
	};

	function currentPicker(): PickerState | null {
		const settings = getSettings?.() ?? DEFAULT_DOLLAR_SETTINGS;
		if (!settings.pickerEnabled) return null;
		const activeSkillNames = settings.respectLoadout ? getActiveSkillNames?.() : undefined;
		const picker = getPickerState(
			baseEditor,
			getCommands(),
			settings.maxSuggestions,
			activeSkillNames,
		);
		if (!picker) return null;
		if (state.closedPrefix === picker.token.prefix) return null;

		if (state.lastPrefix !== picker.token.prefix) {
			state.selectedIndex = 0;
			state.lastPrefix = picker.token.prefix;
			state.closedPrefix = undefined;
		}

		state.selectedIndex = clamp(state.selectedIndex, 0, picker.items.length - 1);
		return picker;
	}

	function requestRender() {
		if (typeof tui?.requestRender === "function") tui.requestRender();
	}

	function pickerLineLimit(): number | undefined {
		const candidates = [
			tui?.height,
			tui?.rows,
			tui?.terminal?.height,
			tui?.terminal?.rows,
			process.stdout?.rows,
		];
		const height = candidates.find(
			(value): value is number => typeof value === "number" && value > 0,
		);
		return height ? Math.max(3, Math.floor(height * 0.3)) : undefined;
	}

	function matchesInput(data: string, action: string, fallbacks: readonly string[]): boolean {
		if (typeof keybindings?.matches === "function" && keybindings.matches(data, action))
			return true;
		return fallbacks.includes(data);
	}

	function applySelection(picker: PickerState): void {
		const selected = picker.items[state.selectedIndex];
		if (!selected) return;

		const deleteCount = picker.token.prefix.length;
		for (let i = 0; i < deleteCount; i += 1) {
			baseEditor.handleInput("\x7f");
		}

		const insertion = `${selected.value} `;

		if (typeof baseEditor.insertTextAtCursor === "function") {
			baseEditor.insertTextAtCursor(insertion);
		} else {
			for (const char of insertion) baseEditor.handleInput(char);
		}

		state.closedPrefix = undefined;
		state.lastPrefix = undefined;
		requestRender();
	}

	return new Proxy(baseEditor, {
		get(target, prop) {
			if (prop === HIGHLIGHT_WRAPPED) return true;
			if (prop === HIGHLIGHT_WRAPPED_VERSION) return WRAPPER_VERSION;
			if (prop === HIGHLIGHT_BASE_EDITOR) return baseEditor;
			if (prop === "handleInput") {
				return (data: string) => {
					const picker = currentPicker();

					if (picker) {
						if (matchesInput(data, "tui.select.up", ["\x1b[A"])) {
							state.selectedIndex =
								state.selectedIndex <= 0 ? picker.items.length - 1 : state.selectedIndex - 1;
							requestRender();
							return;
						}
						if (matchesInput(data, "tui.select.down", ["\x1b[B"])) {
							state.selectedIndex =
								state.selectedIndex >= picker.items.length - 1 ? 0 : state.selectedIndex + 1;
							requestRender();
							return;
						}
						if (
							matchesInput(data, "tui.select.confirm", ["\r", "\n"]) ||
							matchesInput(data, "tui.input.tab", ["\t"])
						) {
							applySelection(picker);
							return;
						}
						if (matchesInput(data, "tui.select.cancel", ["\x1b"])) {
							state.closedPrefix = picker.token.prefix;
							requestRender();
							return;
						}
					}

					target.handleInput(data);
					const settings = getSettings?.() ?? DEFAULT_DOLLAR_SETTINGS;
					const nextPicker = settings.pickerEnabled
						? getPickerState(
								target,
								getCommands(),
								settings.maxSuggestions,
								settings.respectLoadout ? getActiveSkillNames?.() : undefined,
							)
						: null;
					if (!nextPicker || nextPicker.token.prefix !== state.closedPrefix)
						state.closedPrefix = undefined;
				};
			}

			if (prop === "render") {
				return (width: number) => {
					const settings = getSettings?.() ?? DEFAULT_DOLLAR_SETTINGS;
					const baseLines = target
						.render(width)
						.map((line) =>
							settings.highlightReferences
								? highlightDollarSkillReferences(line, getCommands(), theme)
								: line,
						);
					const picker = currentPicker();
					if (!picker) return baseLines;
					return [
						...baseLines,
						...renderSkillPickerLines(
							picker.items,
							state.selectedIndex,
							width,
							theme,
							pickerLineLimit(),
						),
					];
				};
			}

			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},

		set(target, prop, value) {
			return Reflect.set(target, prop, value, target);
		},
	});
}

function isEditorLike(value: unknown): value is EditorLike {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		typeof (value as Partial<EditorLike>).handleInput === "function" &&
		typeof (value as Partial<EditorLike>).render === "function" &&
		typeof (value as Partial<EditorLike>).getLines === "function" &&
		typeof (value as Partial<EditorLike>).getCursor === "function"
	);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		const { access } = await import("node:fs/promises");
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function findPiPackageRoot(): Promise<string | undefined> {
	const { realpath } = await import("node:fs/promises");
	const { dirname, join, parse } = await import("node:path");

	const candidates: string[] = [];
	const entrypoint = process.argv[1];
	if (entrypoint) candidates.push(await realpath(entrypoint).catch(() => entrypoint));
	candidates.push("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/main.js");
	candidates.push("/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/main.js");

	for (const candidate of candidates) {
		let dir = dirname(candidate);
		const root = parse(dir).root;

		while (dir && dir !== root) {
			const packageJson = join(dir, "package.json");
			if (await pathExists(packageJson)) {
				try {
					const { readFile } = await import("node:fs/promises");
					const metadata = JSON.parse(await readFile(packageJson, "utf8"));
					if (metadata.name === "@earendil-works/pi-coding-agent") return dir;
				} catch {
					// Continue walking upward.
				}
			}
			dir = dirname(dir);
		}
	}

	return undefined;
}

async function loadCustomEditor(): Promise<CustomEditorConstructor | undefined> {
	const root = await findPiPackageRoot();
	if (!root) return undefined;

	const { pathToFileURL } = await import("node:url");
	const { join } = await import("node:path");
	const moduleUrl = pathToFileURL(
		join(root, "dist/modes/interactive/components/custom-editor.js"),
	).href;
	const mod = (await import(moduleUrl)) as { CustomEditor?: CustomEditorConstructor };
	return mod.CustomEditor;
}

function createDefaultEditor(
	EditorClass: CustomEditorConstructor | undefined,
	tui: TuiLike,
	theme: DollarTheme,
	keybindings: KeybindingsLike | undefined,
): EditorLike {
	if (!EditorClass) throw new Error("Pi CustomEditor is unavailable");
	return new EditorClass(tui, theme, keybindings);
}

export default function dollarSkillAutocomplete(pi: ExtensionAPI) {
	let settings = DEFAULT_DOLLAR_SETTINGS;

	registerExtensionSettings(pi, {
		id: "pi-codex-dollar",
		title: "PI Codex Dollar",
		description: "Dollar-triggered skill references and inline skill suggestions",
		groups: DOLLAR_SETTING_GROUPS,
		onLoad: (state) => {
			settings = dollarSettingsFromState(state);
		},
		onChange: (change) => {
			settings = dollarSettingsFromState(change.state);
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || typeof ctx.ui.setEditorComponent !== "function") return;

		const previousEditorFactory = ctx.ui.getEditorComponent?.();
		const CustomEditor = await loadCustomEditor();
		if (!previousEditorFactory && !CustomEditor) return;
		const EditorClass = CustomEditor;

		ctx.ui.setEditorComponent(((
			tui: Parameters<NonNullable<typeof previousEditorFactory>>[0],
			theme: Parameters<NonNullable<typeof previousEditorFactory>>[1],
			keybindings: Parameters<NonNullable<typeof previousEditorFactory>>[2],
		) => {
			const dollarTui = tui as TuiLike;
			const dollarTheme = theme as DollarTheme;
			const dollarKeybindings = keybindings as KeybindingsLike | undefined;
			const previousEditor = previousEditorFactory?.(tui, theme, keybindings) as
				| EditorLike
				| undefined;
			const previousMetadata = previousEditor as SymbolMetadata | undefined;
			const shouldDiscardStaleWrapper =
				previousMetadata?.[HIGHLIGHT_WRAPPED] &&
				previousMetadata?.[HIGHLIGHT_WRAPPED_VERSION] !== WRAPPER_VERSION &&
				!previousMetadata?.[HIGHLIGHT_BASE_EDITOR] &&
				EditorClass;
			const baseEditor = shouldDiscardStaleWrapper
				? new EditorClass(dollarTui, dollarTheme, dollarKeybindings)
				: (previousEditor ??
					createDefaultEditor(EditorClass, dollarTui, dollarTheme, dollarKeybindings));
			return createSkillPickerEditor(
				baseEditor,
				() => pi.getCommands(),
				dollarTheme,
				dollarTui,
				dollarKeybindings,
				() => settings,
				() => loadoutActiveSkillNames(ctx),
			);
		}) as unknown as Parameters<typeof ctx.ui.setEditorComponent>[0]);
	});

	pi.on("input", (event) => {
		if (event.source === "extension") return { action: "continue" };
		if (!settings.expandReferences) return { action: "continue" };
		const text = expandDollarSkillReferences(event.text, pi.getCommands());
		if (!text) return { action: "continue" };

		return {
			action: "transform",
			text,
			images: event.images,
		};
	});
}
