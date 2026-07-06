import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Skill,
	Theme,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	fuzzyMatch,
	Input,
	Key,
	matchesKey,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	type ExtensionSettingsSubpanelCreateOptions,
	registerExtensionSettings,
	type SettingGroup,
	type SettingsState,
} from "@hheei/pi-extcore";
import { createLoadoutSettingsStorage } from "./settings-storage.js";
import {
	createLoadoutFooterLines,
	formatLoadoutGroupDescription,
	formatLoadoutPresetDescription,
	formatLoadoutStatusLabel,
	type LoadoutFooterSelectionKind,
	mergeRowsWithDescription,
	stripSettingsListExtraLines,
} from "./tui.js";

const STATE_CUSTOM_TYPE = "pi-loadout:selection";
const LOG_CUSTOM_TYPE = "pi-loadout:loadout changed";
const GLOBAL_LOADOUT_PATH = join(homedir(), ".pi", "agent", "loadout.json");

type StoredState = {
	enabledTools: string[];
	enabledSkills?: string[];
	profileName?: string;
};

type Profile = {
	enabledTools: string[];
	enabledSkills: string[];
	updatedAt: string;
};

type ToolGroup = {
	key: string;
	label: string;
	tools: ToolInfo[];
};

type SkillInfo = {
	name: string;
	commandName: string;
	description?: string;
	sourceInfo?: { source?: string; path?: string };
};

type SkillGroup = {
	key: string;
	label: string;
	skills: SkillInfo[];
};

type Pane = "tools" | "skills";
type LoadoutPresetName = "minimal";
type RowId =
	| `group:${string}`
	| `tool:${string}`
	| `skillgroup:${string}`
	| `skill:${string}`
	| `preset:${string}`;

type RowRef =
	| { kind: "toolGroup"; group: ToolGroup }
	| { kind: "tool"; group: ToolGroup; tool: ToolInfo }
	| { kind: "skillGroup"; group: SkillGroup }
	| { kind: "skill"; group: SkillGroup; skill: SkillInfo }
	| { kind: "preset"; name: string; source: "builtin" | "default" | "user"; profile?: Profile };

type LoadoutResult = {
	enabledTools: Set<string>;
	enabledSkills: Set<string>;
};

type LoadoutDiff = {
	toolsAdded: string[];
	toolsRemoved: string[];
	skillsAdded: string[];
	skillsRemoved: string[];
};

type LoadoutLogDetails = {
	timestamp: string;
	previousLoadout: string;
	newLoadout: string;
	diff: LoadoutDiff;
	commandSource: string;
};

type LoadoutSettings = {
	showStatus: boolean;
	useGlobalDefault: boolean;
	filterSkills: boolean;
	logChanges: boolean;
	showPromptCacheWarning: boolean;
};

const DEFAULT_LOADOUT_SETTINGS: LoadoutSettings = {
	showStatus: true,
	useGlobalDefault: true,
	filterSkills: true,
	logChanges: true,
	showPromptCacheWarning: true,
};

const LOADOUT_SETTING_GROUPS: SettingGroup[] = [
	{
		id: "general",
		title: "General",
		display: "plain",
		fields: [
			{
				id: "showStatus",
				label: "Status bar",
				defaultValue: true,
				description: "Show active tool and skill counts in the Pi footer",
			},
			{
				id: "useGlobalDefault",
				label: "Use global default",
				defaultValue: true,
				description: "Use ~/.pi/agent/loadout.json when a session branch has no saved loadout",
			},
			{
				id: "filterSkills",
				label: "Filter skills",
				defaultValue: true,
				description: "Remove disabled skills from the model system prompt",
			},
			{
				id: "logChanges",
				label: "Session change log",
				defaultValue: true,
				description: "Write visible session log entries when a loadout change has a diff",
			},
			{
				id: "showPromptCacheWarning",
				label: "Prompt cache warning",
				defaultValue: true,
				description: "Show prompt-cache miss warnings in the interactive picker",
			},
		],
	},
];

function loadoutSettingsFromState(state: SettingsState | undefined): LoadoutSettings {
	const general = state?.general ?? {};
	return {
		showStatus: general.showStatus !== false,
		useGlobalDefault: general.useGlobalDefault !== false,
		filterSkills: general.filterSkills !== false,
		logChanges: general.logChanges !== false,
		showPromptCacheWarning: general.showPromptCacheWarning !== false,
	};
}

export default function loadoutExtension(pi: ExtensionAPI) {
	let enabledTools = new Set<string>();
	let enabledSkills = new Set<string>();
	let skillLoadoutExplicit = false;
	let currentProfileName: string | undefined;
	let loadoutSettings = DEFAULT_LOADOUT_SETTINGS;
	let pendingSettingsPresetName: string | undefined;

	registerExtensionSettings(pi, {
		id: "pi-loadout",
		title: "PI Loadout",
		groups: [...LOADOUT_SETTING_GROUPS, ...createPresetSettingGroups()],
		panels: createLoadoutSettingsPanels(),
		storage: createLoadoutSettingsStorage(),
		onLoad: (state, ctx) => {
			loadoutSettings = loadoutSettingsFromState(state);
			updateStatus(ctx);
		},
		onChange: (change, ctx) => {
			if (change.groupId === "preset" && change.fieldId === "preset") {
				pendingSettingsPresetName = selectedPresetNameFromState(change.state);
				loadoutSettings = loadoutSettingsFromState(change.state);
				updateStatus(ctx);
				return;
			}

			loadoutSettings = loadoutSettingsFromState(change.state);
			updateStatus(ctx);
		},
		onClose: (_state, ctx) => {
			if (!pendingSettingsPresetName) return;
			applyNamedLoadoutSilently(
				pendingSettingsPresetName,
				ctx,
				"/extension-setting loadout preset",
			);
			pendingSettingsPresetName = undefined;
		},
	});

	function createLoadoutSettingsPanels() {
		return [
			{
				id: "tools",
				label: "├─ Tools",
				description: "Open the tool loadout picker",
				currentValue: "open",
				create: createLoadoutSubpanel("tools"),
			},
			{
				id: "skills",
				label: "└─ Skills",
				description: "Open the skill loadout picker",
				currentValue: "open",
				create: createLoadoutSubpanel("skills"),
			},
		];
	}

	function createPresetSettingGroups(): SettingGroup[] {
		return [
			{
				id: "preset",
				title: "Preset",
				display: "plain",
				fields: [
					{
						id: "preset",
						label: "● preset",
						defaultValue: currentProfileName === "minimal" ? "minimal" : "default",
						description: presetSettingDescription,
						options: createPresetSettingOptions,
					},
				],
			},
		];
	}

	function presetSettingDescription(theme: Theme): string {
		const tools = sorted(activeToolNames());
		const skills = sorted(activeSkillNames());
		return formatLoadoutPresetDescription({
			tools,
			totalTools: allToolNames().length,
			skills,
			totalSkills: allSkillNames().length,
			theme,
		});
	}

	function createPresetSettingOptions() {
		return [
			{ value: "default", label: "default", description: "Saved default loadout" },
			{ value: "minimal", label: "minimal", description: "Built-in system tools only" },
		];
	}

	function selectedPresetNameFromState(state: SettingsState | undefined): string {
		const value = state?.preset?.preset;
		if (value === "default" || value === "minimal") return value;
		return currentProfileName === "minimal" ? "minimal" : "default";
	}

	function allTools(): ToolInfo[] {
		const byName = new Map<string, ToolInfo>();
		for (const tool of pi.getAllTools()) byName.set(tool.name, tool);
		return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	function allToolNames(): string[] {
		return allTools().map((tool) => tool.name);
	}

	function activeToolNames(): string[] {
		return pi.getActiveTools();
	}

	function allSkills(): SkillInfo[] {
		const byName = new Map<string, SkillInfo>();
		for (const command of pi.getCommands()) {
			if (command.source !== "skill" || !command.name.startsWith("skill:")) continue;
			const name = command.name.slice("skill:".length);
			byName.set(name, {
				name,
				commandName: command.name,
				description: command.description,
				sourceInfo: command.sourceInfo,
			});
		}
		return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	function allSkillNames(): string[] {
		return allSkills().map((skill) => skill.name);
	}

	function activeSkillNames(): string[] {
		if (!skillLoadoutExplicit) return allSkillNames();
		const available = new Set(allSkillNames());
		return [...enabledSkills].filter((name) => available.has(name));
	}

	function isBuiltinSource(sourceInfo: { source?: string; path?: string } | undefined): boolean {
		return sourceInfo?.source === "builtin" || !!sourceInfo?.path?.startsWith("<builtin:");
	}

	function sourceLabel(
		sourceInfo: { source?: string; path?: string } | undefined,
		labels: { fallback: string; builtin: string; sdk: string },
	): string {
		const source = sourceInfo?.source;
		if (source === "builtin") return labels.builtin;
		if (source === "sdk") return labels.sdk;
		if (source && source !== "unknown") return source;

		const path = sourceInfo?.path;
		if (!path) return labels.fallback;
		if (isBuiltinSource(sourceInfo)) return labels.builtin;
		return path;
	}

	function groupTools(tools: ToolInfo[]): ToolGroup[] {
		const byKey = new Map<string, ToolGroup>();

		for (const tool of tools) {
			const key = sourceLabel(tool.sourceInfo, {
				fallback: "Other tools",
				builtin: "Built-in tools",
				sdk: "SDK tools",
			});
			const group = byKey.get(key);
			if (group) group.tools.push(tool);
			else byKey.set(key, { key, label: key, tools: [tool] });
		}

		return [...byKey.values()].sort((a, b) => {
			if (a.label === "Built-in tools") return -1;
			if (b.label === "Built-in tools") return 1;
			return a.label.localeCompare(b.label);
		});
	}

	function groupSkills(skills: SkillInfo[]): SkillGroup[] {
		const byKey = new Map<string, SkillGroup>();

		for (const skill of skills) {
			const key = sourceLabel(skill.sourceInfo, {
				fallback: "Other skills",
				builtin: "Built-in skills",
				sdk: "SDK skills",
			});
			const group = byKey.get(key);
			if (group) group.skills.push(skill);
			else byKey.set(key, { key, label: key, skills: [skill] });
		}

		return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
	}

	function presetTools(_name: LoadoutPresetName): Set<string> {
		return new Set(
			allTools()
				.filter((tool) => isBuiltinSource(tool.sourceInfo))
				.map((tool) => tool.name),
		);
	}

	function presetSkills(_name: LoadoutPresetName): Set<string> {
		return new Set();
	}

	function presetProfile(name: LoadoutPresetName): Profile {
		return {
			enabledTools: sorted(presetTools(name)),
			enabledSkills: sorted(presetSkills(name)),
			updatedAt: new Date(0).toISOString(),
		};
	}

	function isLoadoutPresetName(name: string): name is LoadoutPresetName {
		return name === "minimal";
	}

	function profileFromStoredState(state: StoredState): Profile {
		return {
			enabledTools: sorted(state.enabledTools),
			enabledSkills: sorted(state.enabledSkills ?? allSkillNames()),
			updatedAt: new Date(0).toISOString(),
		};
	}

	function normalizeEnabledTools(names: Iterable<string>): Set<string> {
		const available = new Set(allToolNames());
		return new Set([...names].filter((name) => available.has(name)));
	}

	function normalizeEnabledSkills(names: Iterable<string>): Set<string> {
		const available = new Set(allSkillNames());
		return new Set([...names].filter((name) => available.has(name)));
	}

	function sorted(names: Iterable<string>): string[] {
		return [...new Set(names)].sort((a, b) => a.localeCompare(b));
	}

	function parseStoredState(value: unknown): StoredState | undefined {
		if (!value || typeof value !== "object") return undefined;
		const data = value as Partial<StoredState>;
		if (!Array.isArray(data.enabledTools)) return undefined;

		const enabledTools = data.enabledTools.filter(
			(name): name is string => typeof name === "string",
		);
		const enabledSkills = Array.isArray(data.enabledSkills)
			? data.enabledSkills.filter((name): name is string => typeof name === "string")
			: undefined;
		const profileName = typeof data.profileName === "string" ? data.profileName : undefined;

		return { enabledTools, enabledSkills, profileName };
	}

	function toStoredState(
		nextTools: Set<string>,
		nextSkills: Set<string>,
		profileName?: string,
	): StoredState {
		const state: StoredState = {
			enabledTools: sorted(nextTools),
			enabledSkills: sorted(nextSkills),
		};
		if (profileName) state.profileName = profileName;
		return state;
	}

	function isCurrentDirty(): boolean {
		if (!currentProfileName) return false;
		const profile =
			currentProfileName === "minimal"
				? presetProfile("minimal")
				: currentProfileName === "default"
					? readGlobalLoadout()
						? profileFromStoredState(readGlobalLoadout()!)
						: undefined
					: undefined;
		if (!profile) return false;
		const tools = sorted(enabledTools).join("\u0001");
		const skills = sorted(enabledSkills).join("\u0001");
		return (
			tools !== profile.enabledTools.join("\u0001") ||
			skills !== profile.enabledSkills.join("\u0001")
		);
	}

	function readGlobalLoadout(): StoredState | undefined {
		try {
			return parseStoredState(JSON.parse(readFileSync(GLOBAL_LOADOUT_PATH, "utf8")));
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return undefined;
			return undefined;
		}
	}

	function writeGlobalLoadout(state: StoredState) {
		mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
		writeFileSync(GLOBAL_LOADOUT_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	}

	function setDifference(next: Set<string>, previous: Set<string>): string[] {
		return sorted([...next].filter((name) => !previous.has(name)));
	}

	function computeDiff(
		currentTools: Set<string>,
		targetTools: Set<string>,
		currentSkills: Set<string>,
		targetSkills: Set<string>,
	): LoadoutDiff {
		return {
			toolsAdded: setDifference(targetTools, currentTools),
			toolsRemoved: setDifference(currentTools, targetTools),
			skillsAdded: setDifference(targetSkills, currentSkills),
			skillsRemoved: setDifference(currentSkills, targetSkills),
		};
	}

	function hasDiff(diff: LoadoutDiff): boolean {
		return (
			diff.toolsAdded.length +
				diff.toolsRemoved.length +
				diff.skillsAdded.length +
				diff.skillsRemoved.length >
			0
		);
	}

	function formatInlineDiff(added: string[], removed: string[]): string {
		return [...added.map((name) => `+${name}`), ...removed.map((name) => `-${name}`)].join(" ");
	}

	function formatLoadoutLog(diff: LoadoutDiff): string {
		const lines: string[] = [];
		if (diff.toolsAdded.length + diff.toolsRemoved.length > 0) {
			lines.push(`Tools: ${formatInlineDiff(diff.toolsAdded, diff.toolsRemoved)}`);
		}
		if (diff.skillsAdded.length + diff.skillsRemoved.length > 0) {
			lines.push(`Skills: ${formatInlineDiff(diff.skillsAdded, diff.skillsRemoved)}`);
		}
		return lines.join("\n");
	}

	function logAppliedLoadout(diff: LoadoutDiff, commandSource: string) {
		if (!loadoutSettings.logChanges) return;
		pi.sendMessage<LoadoutLogDetails>(
			{
				customType: LOG_CUSTOM_TYPE,
				content: formatLoadoutLog(diff),
				display: true,
				details: {
					timestamp: new Date().toISOString(),
					previousLoadout: "before",
					newLoadout: "after",
					diff,
					commandSource,
				},
			},
			{ triggerTurn: false },
		);
	}

	function isLoadoutLogItem(item: unknown): boolean {
		return (item as { customType?: string }).customType === LOG_CUSTOM_TYPE;
	}

	function filterLoadoutLogItemsInPlace<T>(items: T[]) {
		items.splice(0, items.length, ...items.filter((item) => !isLoadoutLogItem(item)));
	}

	function applyEnabledInMemory(nextTools: Set<string>, nextSkills: Set<string>) {
		enabledTools = normalizeEnabledTools(nextTools);
		enabledSkills = normalizeEnabledSkills(nextSkills);
		skillLoadoutExplicit = true;
		pi.setActiveTools([...enabledTools]);
	}

	function persistEnabled() {
		pi.appendEntry<StoredState>(
			STATE_CUSTOM_TYPE,
			toStoredState(enabledTools, enabledSkills, currentProfileName),
		);
	}

	function commitLoadout(
		previousTools: Set<string>,
		previousSkills: Set<string>,
		nextTools: Set<string>,
		nextSkills: Set<string>,
		ctx: ExtensionContext,
		commandSource: string,
		nextProfileName?: string | null,
	): LoadoutDiff {
		const targetTools = normalizeEnabledTools(nextTools);
		const targetSkills = normalizeEnabledSkills(nextSkills);
		const diff = computeDiff(previousTools, targetTools, previousSkills, targetSkills);

		applyEnabledInMemory(targetTools, targetSkills);
		if (nextProfileName === null) currentProfileName = undefined;
		else if (typeof nextProfileName === "string") currentProfileName = nextProfileName;
		updateStatus(ctx);

		if (!hasDiff(diff) && nextProfileName === undefined) return diff;

		persistEnabled();
		if (hasDiff(diff)) logAppliedLoadout(diff, commandSource);
		return diff;
	}

	function saveGlobalLoadout(
		nextTools: Set<string>,
		nextSkills: Set<string>,
		ctx: ExtensionContext,
		options: { notify?: boolean } = {},
	) {
		const targetTools = normalizeEnabledTools(nextTools);
		const targetSkills = normalizeEnabledSkills(nextSkills);
		currentProfileName = "default";
		writeGlobalLoadout(toStoredState(targetTools, targetSkills, currentProfileName));
		if (options.notify === false) return;
		ctx.ui.notify(
			`Saved default loadout: ${targetTools.size}/${allToolNames().length} tools, ${targetSkills.size}/${allSkillNames().length} skills enabled. Future sessions will use it.`,
			"info",
		);
	}

	function applyPreset(
		name: LoadoutPresetName,
		ctx: ExtensionContext,
		commandSource: string,
	): LoadoutDiff {
		const previousTools = normalizeEnabledTools(activeToolNames());
		const previousSkills = normalizeEnabledSkills(activeSkillNames());
		const targetTools = presetTools(name);
		const targetSkills = presetSkills(name);
		const diff = commitLoadout(
			previousTools,
			previousSkills,
			targetTools,
			targetSkills,
			ctx,
			commandSource,
			name,
		);
		const label = "Minimal";
		const suffix = hasDiff(diff) ? " Next response may miss prompt cache." : " Nothing changed.";
		ctx.ui.notify(
			`${label} preset applied: ${targetTools.size}/${allToolNames().length} tools, ${targetSkills.size}/${allSkillNames().length} skills enabled.${suffix}`,
			"info",
		);
		return diff;
	}

	function readBranchLoadout(ctx: ExtensionContext): StoredState | undefined {
		let restored: StoredState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_CUSTOM_TYPE) continue;
			restored = parseStoredState(entry.data);
		}
		return restored;
	}

	function applyDefaultLoadout(
		ctx: ExtensionContext,
		commandSource: string,
	): LoadoutDiff | undefined {
		const state = readGlobalLoadout();
		if (!state) {
			ctx.ui.notify(
				`No saved default loadout found. Checked ${GLOBAL_LOADOUT_PATH}. Open /loadout and change the selection to save one.`,
				"warning",
			);
			return undefined;
		}

		const previousTools = normalizeEnabledTools(activeToolNames());
		const previousSkills = normalizeEnabledSkills(activeSkillNames());
		const targetTools = normalizeEnabledTools(state.enabledTools);
		const targetSkills = state.enabledSkills
			? normalizeEnabledSkills(state.enabledSkills)
			: new Set(allSkillNames());
		const diff = commitLoadout(
			previousTools,
			previousSkills,
			targetTools,
			targetSkills,
			ctx,
			commandSource,
			"default",
		);
		const suffix = hasDiff(diff) ? " Next response may miss prompt cache." : " Nothing changed.";
		ctx.ui.notify(
			`Default loadout applied: ${targetTools.size}/${allToolNames().length} tools, ${targetSkills.size}/${allSkillNames().length} skills enabled.${suffix}`,
			"info",
		);
		return diff;
	}

	function applyNamedLoadoutSilently(
		name: string,
		ctx: ExtensionContext,
		commandSource: string,
	): LoadoutDiff | undefined {
		const previousTools = normalizeEnabledTools(activeToolNames());
		const previousSkills = normalizeEnabledSkills(activeSkillNames());
		let targetTools: Set<string>;
		let targetSkills: Set<string>;
		let nextProfileName: string | null = name;

		if (isLoadoutPresetName(name)) {
			targetTools = presetTools(name);
			targetSkills = presetSkills(name);
		} else if (name === "default") {
			const state = readGlobalLoadout();
			if (!state) {
				ctx.ui.notify(
					`No saved default loadout found. Checked ${GLOBAL_LOADOUT_PATH}. Open /loadout and change the selection to save one.`,
					"warning",
				);
				return undefined;
			}
			targetTools = normalizeEnabledTools(state.enabledTools);
			targetSkills = state.enabledSkills
				? normalizeEnabledSkills(state.enabledSkills)
				: new Set(allSkillNames());
			nextProfileName = "default";
		} else {
			ctx.ui.notify(
				`Unknown loadout preset: ${name}. Available presets: default, minimal.`,
				"warning",
			);
			return undefined;
		}

		const diff = commitLoadout(
			previousTools,
			previousSkills,
			targetTools,
			targetSkills,
			ctx,
			commandSource,
			nextProfileName,
		);
		if (loadoutSettings.showPromptCacheWarning && hasDiff(diff))
			ctx.ui.notify("Loadout changed. Next response may miss prompt cache.", "warning");
		return diff;
	}

	function formatProfileList(): string {
		const lines = ["Loadout presets:"];
		const defaultState = readGlobalLoadout();
		lines.push(
			defaultState
				? `  default   saved · ${normalizeEnabledTools(defaultState.enabledTools).size}/${allToolNames().length} tools · ${normalizeEnabledSkills(defaultState.enabledSkills ?? allSkillNames()).size}/${allSkillNames().length} skills`
				: "  default   saved · not saved",
		);
		lines.push(
			`  minimal   built-in · ${presetTools("minimal").size}/${allToolNames().length} tools · ${presetSkills("minimal").size}/${allSkillNames().length} skills`,
		);
		return lines.join("\n");
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		const state =
			readBranchLoadout(ctx) ??
			(loadoutSettings.useGlobalDefault ? readGlobalLoadout() : undefined);
		// Built-in presets are dynamic: re-expand them against the currently available
		// tools/skills instead of replaying a frozen list, so they self-heal when the
		// installed tool/skill set changes between sessions.
		if (state?.profileName && isLoadoutPresetName(state.profileName)) {
			enabledTools = presetTools(state.profileName);
			enabledSkills = presetSkills(state.profileName);
			skillLoadoutExplicit = true;
			currentProfileName = state.profileName;
			pi.setActiveTools([...enabledTools]);
			return;
		}
		enabledTools = state ? normalizeEnabledTools(state.enabledTools) : new Set(allToolNames());
		skillLoadoutExplicit = !!state?.enabledSkills;
		enabledSkills = state?.enabledSkills
			? normalizeEnabledSkills(state.enabledSkills)
			: new Set(allSkillNames());
		currentProfileName = state ? "default" : undefined;
		pi.setActiveTools([...enabledTools]);
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!loadoutSettings.showStatus) {
			ctx.ui.setStatus("loadout", undefined);
			return;
		}

		const counts = `${activeToolNames().length}/${allToolNames().length} tools · ${activeSkillNames().length}/${allSkillNames().length} skills`;
		const prefix = currentProfileName
			? `${currentProfileName}${isCurrentDirty() ? "*" : ""} · `
			: "";
		ctx.ui.setStatus("loadout", `${prefix}${counts}`);
	}

	function replaceSkillsBlock(systemPrompt: string, nextSkills: Skill[]): string {
		const skillBlockPattern =
			/\n?The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;
		const nextBlock = formatSkillsForPrompt(nextSkills);
		if (skillBlockPattern.test(systemPrompt))
			return systemPrompt.replace(skillBlockPattern, nextBlock ? `\n${nextBlock}` : "");
		return systemPrompt;
	}

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
		updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
		updateStatus(ctx);
	});

	pi.on("session_before_compact", async (event) => {
		filterLoadoutLogItemsInPlace(event.preparation.messagesToSummarize);
		filterLoadoutLogItemsInPlace(event.preparation.turnPrefixMessages);
		filterLoadoutLogItemsInPlace(event.branchEntries);
	});

	pi.on("session_before_tree", async (event) => {
		filterLoadoutLogItemsInPlace(event.preparation.entriesToSummarize);
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((message) => !isLoadoutLogItem(message)),
		};
	});

	pi.on("before_agent_start", async (event) => {
		if (!loadoutSettings.filterSkills) return;
		const skills = event.systemPromptOptions.skills ?? [];
		if (skills.length === 0) return;

		if (!skillLoadoutExplicit) return;

		const availableNames = new Set(skills.map((skill) => skill.name));
		const normalized = new Set([...enabledSkills].filter((name) => availableNames.has(name)));
		const filteredSkills = skills.filter((skill) => normalized.has(skill.name));
		if (filteredSkills.length === skills.length) return;

		return { systemPrompt: replaceSkillsBlock(event.systemPrompt, filteredSkills) };
	});

	function formatStatus(): string {
		const activeTools = new Set(activeToolNames());
		const activeSkills = new Set(activeSkillNames());
		const lines: string[] = [];
		lines.push(
			`Active: ${activeTools.size}/${allToolNames().length} tools · ${activeSkills.size}/${allSkillNames().length} skills`,
		);

		const toolGroups = groupTools(allTools());
		if (toolGroups.length > 0) {
			lines.push("", "Tools:");
			for (const group of toolGroups) {
				const on = group.tools.filter((t) => activeTools.has(t.name)).length;
				lines.push(`  ${group.label} (${on}/${group.tools.length})`);
				for (const t of group.tools) {
					lines.push(`    ${activeTools.has(t.name) ? "●" : "○"} ${t.name}`);
				}
			}
		}

		const skillGroups = groupSkills(allSkills());
		if (skillGroups.length > 0) {
			lines.push("", "Skills:");
			for (const group of skillGroups) {
				const on = group.skills.filter((s) => activeSkills.has(s.name)).length;
				lines.push(`  ${group.label} (${on}/${group.skills.length})`);
				for (const s of group.skills) {
					lines.push(`    ${activeSkills.has(s.name) ? "●" : "○"} ${s.name}`);
				}
			}
		}

		return lines.join("\n");
	}

	function loadoutHelp(): string {
		return [
			"/loadout commands:",
			"  /loadout          Open interactive picker",
			"  /loadout minimal  Enable built-in system tools only",
			"  /loadout default  Apply saved default loadout",
			"  /loadout list     List available presets",
			"  /loadout status   Print current active tools and skills",
			"  /loadout help     Show this help",
		].join("\n");
	}

	function createLoadoutSubpanel(
		initialPane: Pane,
	): (options: ExtensionSettingsSubpanelCreateOptions) => Component {
		return (options) =>
			createLoadoutPickerComponent(
				options.ctx,
				options.host,
				options.theme,
				options.close,
				`/extension-setting loadout ${initialPane}`,
				initialPane,
			);
	}

	function createLoadoutPickerComponent(
		ctx: ExtensionCommandContext,
		tui: { requestRender(): void },
		theme: Theme,
		done: () => void,
		commandSource: string,
		initialPane?: Pane,
	): Component {
		const tools = allTools();
		const skills = allSkills();
		if (tools.length === 0 && skills.length === 0) {
			ctx.ui.notify("No tools or skills available.", "warning");
			queueMicrotask(done);
			return {
				render() {
					return ["No tools or skills available."];
				},
				invalidate() {},
			};
		}

		const toolGroups = groupTools(tools);
		const skillGroups = groupSkills(skills);
		const draftEnabledTools = normalizeEnabledTools(activeToolNames());
		const draftEnabledSkills = normalizeEnabledSkills(
			skillLoadoutExplicit ? enabledSkills : allSkillNames(),
		);
		const rowRefs = new Map<RowId, RowRef>();

		function toolGroupValue(group: ToolGroup): "enabled" | "disabled" | "partial" {
			const count = group.tools.filter((tool) => draftEnabledTools.has(tool.name)).length;
			if (count === 0) return "disabled";
			if (count === group.tools.length) return "enabled";
			return "partial";
		}

		function skillGroupValue(group: SkillGroup): "enabled" | "disabled" | "partial" {
			const count = group.skills.filter((skill) => draftEnabledSkills.has(skill.name)).length;
			if (count === 0) return "disabled";
			if (count === group.skills.length) return "enabled";
			return "partial";
		}

		const collapsedToolGroups = new Set<string>();
		const collapsedSkillGroups = new Set<string>();
		let searchQuery = "";
		let pane: Pane =
			initialPane === "tools" && tools.length === 0 ? "skills" : (initialPane ?? "tools");

		function matchesQuery(text: string): boolean {
			return fuzzyMatch(searchQuery, text).matches;
		}

		function isEnabledSettingValue(value: string): boolean {
			return value.trim().startsWith("enabled");
		}
		let visibleRowIds: RowId[] = [];
		const paneSelectedIndex: Record<Pane, number> = { tools: 0, skills: 0 };

		function toolGroupDescription(group: ToolGroup): string {
			const count = group.tools.filter((tool) => draftEnabledTools.has(tool.name)).length;
			return formatLoadoutGroupDescription(group.label, count, group.tools.length);
		}

		function skillGroupDescription(group: SkillGroup): string {
			const count = group.skills.filter((skill) => draftEnabledSkills.has(skill.name)).length;
			return formatLoadoutGroupDescription(group.label, count, group.skills.length);
		}

		function buildToolItems(): SettingItem[] {
			const items: SettingItem[] = [];
			const query = searchQuery.trim();

			for (const group of toolGroups) {
				const groupMatch = query === "" || matchesQuery(group.label);
				const tools =
					query === "" || groupMatch
						? group.tools
						: group.tools.filter((tool) => matchesQuery(tool.name));
				if (query !== "" && !groupMatch && tools.length === 0) continue;

				const groupId = `group:${group.key}` as RowId;
				const collapsed = query === "" && collapsedToolGroups.has(group.key);
				rowRefs.set(groupId, { kind: "toolGroup", group });
				visibleRowIds.push(groupId);
				items.push({
					id: groupId,
					label: formatLoadoutStatusLabel("", toolGroupValue(group), group.label),
					description: toolGroupDescription(group),
					currentValue: toolGroupValue(group),
					values: ["enabled", "disabled"],
				});

				if (collapsed) continue;

				tools.forEach((tool, index) => {
					const toolId = `tool:${tool.name}` as RowId;
					const branch = index === tools.length - 1 ? "╰─" : "├─";
					rowRefs.set(toolId, { kind: "tool", group, tool });
					visibleRowIds.push(toolId);
					items.push({
						id: toolId,
						label: formatLoadoutStatusLabel(
							`${branch} `,
							draftEnabledTools.has(tool.name) ? "enabled" : "disabled",
							tool.name,
						),
						description: tool.description,
						currentValue: draftEnabledTools.has(tool.name) ? "enabled" : "disabled",
						values: ["enabled", "disabled"],
					});
				});
			}

			return items;
		}

		function buildSkillItems(): SettingItem[] {
			const items: SettingItem[] = [];
			const query = searchQuery.trim();

			for (const group of skillGroups) {
				const groupMatch = query === "" || matchesQuery(group.label);
				const skills =
					query === "" || groupMatch
						? group.skills
						: group.skills.filter((skill) => matchesQuery(skill.name));
				if (query !== "" && !groupMatch && skills.length === 0) continue;

				const groupId = `skillgroup:${group.key}` as RowId;
				const collapsed = query === "" && collapsedSkillGroups.has(group.key);
				rowRefs.set(groupId, { kind: "skillGroup", group });
				visibleRowIds.push(groupId);
				items.push({
					id: groupId,
					label: formatLoadoutStatusLabel("", skillGroupValue(group), group.label),
					description: skillGroupDescription(group),
					currentValue: skillGroupValue(group),
					values: ["enabled", "disabled"],
				});

				if (collapsed) continue;

				skills.forEach((skill, index) => {
					const skillId = `skill:${skill.name}` as RowId;
					const branch = index === skills.length - 1 ? "╰─" : "├─";
					rowRefs.set(skillId, { kind: "skill", group, skill });
					visibleRowIds.push(skillId);
					items.push({
						id: skillId,
						label: formatLoadoutStatusLabel(
							`${branch} `,
							draftEnabledSkills.has(skill.name) ? "enabled" : "disabled",
							skill.name,
						),
						description: skill.description,
						currentValue: draftEnabledSkills.has(skill.name) ? "enabled" : "disabled",
						values: ["enabled", "disabled"],
					});
				});
			}

			return items;
		}

		function buildItems(): SettingItem[] {
			visibleRowIds = [];
			rowRefs.clear();
			if (pane === "tools") return buildToolItems();
			return buildSkillItems();
		}

		const initialEnabledTools = normalizeEnabledTools(activeToolNames());
		const initialEnabledSkills = normalizeEnabledSkills(activeSkillNames());

		function finish(result: LoadoutResult | undefined): void {
			const diff = commitLoadout(
				initialEnabledTools,
				initialEnabledSkills,
				result?.enabledTools ?? draftEnabledTools,
				result?.enabledSkills ?? draftEnabledSkills,
				ctx,
				commandSource,
			);
			if (loadoutSettings.showPromptCacheWarning && hasDiff(diff)) {
				ctx.ui.notify("Loadout changed. Next response may miss prompt cache.", "warning");
			}
			done();
		}

		function saveDraftDefaultSilently() {
			try {
				persistEnabled();
				saveGlobalLoadout(draftEnabledTools, draftEnabledSkills, ctx, { notify: false });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to save default loadout: ${message}`, "error");
			}
		}

		let settingsList: SettingsList;
		let selectedIndex = paneSelectedIndex[pane];
		let helpVisible = false;
		const items = buildItems();
		const headerText = new Text("", 1, 0);
		const searchInput = new Input();
		searchInput.focused = true;
		function updateHeader() {
			const toolsLabel =
				pane === "tools" ? theme.fg("accent", theme.bold("[Tools]")) : theme.fg("dim", "Tools");
			const skillsLabel =
				pane === "skills" ? theme.fg("accent", theme.bold("[Skills]")) : theme.fg("dim", "Skills");
			headerText.setText(`${toolsLabel}  ${skillsLabel}`);
		}

		function searchPlaceholder(): string {
			return "type to search";
		}

		function renderSearchInput(width: number): string[] {
			if (searchInput.getValue() !== "") return searchInput.render(width);
			return [truncateToWidth(`> ${theme.fg("dim", searchPlaceholder())}`, width)];
		}

		function setSettingsSelectedIndex() {
			selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(items.length - 1, 0)));
			paneSelectedIndex[pane] = selectedIndex;
			(settingsList as unknown as { selectedIndex: number }).selectedIndex = selectedIndex;
		}

		function syncSelectedIndex() {
			selectedIndex = (settingsList as unknown as { selectedIndex: number }).selectedIndex;
			paneSelectedIndex[pane] = selectedIndex;
		}

		function rebuildItems(preferredId?: RowId) {
			const nextItems = buildItems();
			items.splice(0, items.length, ...nextItems);

			selectedIndex = paneSelectedIndex[pane];
			if (preferredId) {
				const preferredIndex = visibleRowIds.indexOf(preferredId);
				if (preferredIndex !== -1) selectedIndex = preferredIndex;
			}

			updateHeader();
			setSettingsSelectedIndex();
			tui.requestRender();
		}

		function refreshValues() {
			if (pane === "tools") {
				for (const group of toolGroups) {
					const groupId = `group:${group.key}`;
					settingsList.updateValue(groupId, toolGroupValue(group));
					const item = items.find((item) => item.id === groupId);
					if (item) {
						item.label = formatLoadoutStatusLabel("", toolGroupValue(group), group.label);
						item.description = toolGroupDescription(group);
					}

					group.tools.forEach((tool, index) => {
						const toolId = `tool:${tool.name}`;
						const value = draftEnabledTools.has(tool.name) ? "enabled" : "disabled";
						settingsList.updateValue(toolId, value);
						const item = items.find((item) => item.id === toolId);
						if (item) {
							const branch = index === group.tools.length - 1 ? "╰─" : "├─";
							item.label = formatLoadoutStatusLabel(`${branch} `, value, tool.name);
						}
					});
				}
			} else if (pane === "skills") {
				for (const group of skillGroups) {
					const groupId = `skillgroup:${group.key}`;
					settingsList.updateValue(groupId, skillGroupValue(group));
					const item = items.find((item) => item.id === groupId);
					if (item) {
						item.label = formatLoadoutStatusLabel("", skillGroupValue(group), group.label);
						item.description = skillGroupDescription(group);
					}

					group.skills.forEach((skill, index) => {
						const skillId = `skill:${skill.name}`;
						const value = draftEnabledSkills.has(skill.name) ? "enabled" : "disabled";
						settingsList.updateValue(skillId, value);
						const item = items.find((item) => item.id === skillId);
						if (item) {
							const branch = index === group.skills.length - 1 ? "╰─" : "├─";
							item.label = formatLoadoutStatusLabel(`${branch} `, value, skill.name);
						}
					});
				}
			}
			tui.requestRender();
		}
		function formatFooterDescription(row: RowRef | undefined): string | undefined {
			if (!row) return undefined;
			const profile = currentProfileName ?? "default";
			const group =
				row.kind === "toolGroup" || row.kind === "tool"
					? row.group.label
					: row.kind === "skillGroup" || row.kind === "skill"
						? row.group.label
						: undefined;
			if (!group) return profile;
			return `${profile} · ${group.replace(/\s+(tools|skills)$/i, "")}`;
		}

		function loadoutFooter(width: number): string[] {
			const selectedId = visibleRowIds[selectedIndex];
			const selectedRow = selectedId ? rowRefs.get(selectedId) : undefined;
			const selectedItem = items[selectedIndex];
			const selectedKind = selectedRow?.kind as LoadoutFooterSelectionKind | undefined;
			const selectedGroupCollapsed =
				selectedRow?.kind === "toolGroup"
					? collapsedToolGroups.has(selectedRow.group.key)
					: selectedRow?.kind === "skillGroup"
						? collapsedSkillGroups.has(selectedRow.group.key)
						: undefined;

			return createLoadoutFooterLines({
				pane,
				selectedIndex,
				total: items.length,
				selectedDescription: formatFooterDescription(selectedRow),
				selectedSpaceAction: selectedItem?.currentValue === "enabled" ? "disable" : "enable",
				selectedKind,
				selectedGroupCollapsed,
				width,
				theme: {
					dim: (text) => theme.fg("dim", text),
					key: (text) => theme.fg("accent", theme.bold(text)),
				},
			});
		}

		function renderLoadoutList(width: number): string[] {
			const rowLines = stripSettingsListExtraLines(settingsList.render(width));
			const selectedId = visibleRowIds[selectedIndex];
			const selectedRow = selectedId ? rowRefs.get(selectedId) : undefined;
			const selectedItem = items[selectedIndex];
			const rowsWithDescription = mergeRowsWithDescription(
				rowLines,
				selectedRow?.kind === "tool" || selectedRow?.kind === "skill"
					? selectedItem?.description
					: undefined,
				width,
				{ title: (text) => theme.fg("accent", theme.bold(text)) },
			);
			return [...rowsWithDescription, ...loadoutFooter(width)];
		}

		function toggleSelectedGroupCollapse() {
			const selectedId = visibleRowIds[selectedIndex];
			if (!selectedId) return;
			const row = rowRefs.get(selectedId);
			if (!row) return;

			if (row.kind === "toolGroup" || row.kind === "tool") {
				const groupId = `group:${row.group.key}` as RowId;
				if (collapsedToolGroups.has(row.group.key)) collapsedToolGroups.delete(row.group.key);
				else collapsedToolGroups.add(row.group.key);
				rebuildItems(groupId);
				return;
			}

			if (row.kind === "skillGroup" || row.kind === "skill") {
				const groupId = `skillgroup:${row.group.key}` as RowId;
				if (collapsedSkillGroups.has(row.group.key)) collapsedSkillGroups.delete(row.group.key);
				else collapsedSkillGroups.add(row.group.key);
				rebuildItems(groupId);
				return;
			}

			applyPresetRow(row);
		}

		function applyPresetRow(row: Extract<RowRef, { kind: "preset" }>) {
			if (!row.profile) {
				ctx.ui.notify(`No saved ${row.name} loadout found.`, "warning");
				return;
			}

			draftEnabledTools.clear();
			for (const name of normalizeEnabledTools(row.profile.enabledTools))
				draftEnabledTools.add(name);
			draftEnabledSkills.clear();
			for (const name of normalizeEnabledSkills(row.profile.enabledSkills))
				draftEnabledSkills.add(name);
			applyEnabledInMemory(draftEnabledTools, draftEnabledSkills);
			if (row.source === "default") {
				currentProfileName = readGlobalLoadout()?.profileName;
			} else {
				currentProfileName = row.name;
			}
			saveDraftDefaultSilently();
			updateStatus(ctx);
			rebuildItems(`preset:${row.name}` as RowId);
		}

		function switchPane() {
			syncSelectedIndex();
			pane = pane === "tools" ? "skills" : "tools";
			selectedIndex = paneSelectedIndex[pane];
			rebuildItems();
		}

		function applySearch() {
			paneSelectedIndex[pane] = 0;
			selectedIndex = 0;
			rebuildItems();
		}

		const listTheme: SettingsListTheme = {
			cursor: theme.fg("accent", "→ "),
			label: (text: string, selected: boolean) => {
				const trimmed = text.trimStart();
				if (selected) return theme.fg("accent", theme.bold(text));
				if (trimmed.includes("●")) return theme.fg("success", text);
				if (trimmed.includes("◐")) return theme.fg("warning", text);
				if (trimmed.includes("○")) return theme.fg("dim", text);
				return text;
			},
			value: (text: string, selected: boolean) => {
				const trimmed = text.trim();
				if (
					[
						"enabled",
						"disabled",
						"partial",
						"apply",
						"builtin",
						"default",
						"user",
						"active",
						"active*",
					].includes(trimmed)
				)
					return "";
				return selected ? theme.fg("accent", text) : theme.fg("muted", text);
			},
			description: (text: string) => theme.fg("dim", text),
			hint: (text: string) =>
				theme.fg(
					"dim",
					text.replace("Enter/Space to change", "Space to change · Enter collapse/expand"),
				),
		};

		settingsList = new SettingsList(
			items,
			Math.min(Math.max(items.length, 1), 18),
			listTheme,
			(id, newValue) => {
				const row = rowRefs.get(id as RowId);
				if (!row) return;

				if (row.kind === "preset") {
					applyPresetRow(row);
					return;
				}

				if (row.kind === "toolGroup") {
					for (const tool of row.group.tools) {
						if (newValue === "enabled") draftEnabledTools.add(tool.name);
						else draftEnabledTools.delete(tool.name);
					}
				} else if (row.kind === "tool") {
					if (isEnabledSettingValue(newValue)) draftEnabledTools.add(row.tool.name);
					else draftEnabledTools.delete(row.tool.name);
				} else if (row.kind === "skillGroup") {
					for (const skill of row.group.skills) {
						if (newValue === "enabled") draftEnabledSkills.add(skill.name);
						else draftEnabledSkills.delete(skill.name);
					}
				} else if (isEnabledSettingValue(newValue)) {
					draftEnabledSkills.add(row.skill.name);
				} else {
					draftEnabledSkills.delete(row.skill.name);
				}

				applyEnabledInMemory(draftEnabledTools, draftEnabledSkills);
				updateStatus(ctx);
				saveDraftDefaultSilently();
				refreshValues();
			},
			() =>
				finish({
					enabledTools: new Set(draftEnabledTools),
					enabledSkills: new Set(draftEnabledSkills),
				}),
		);

		updateHeader();
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));
		container.addChild(headerText);
		container.addChild({
			render: renderSearchInput,
			invalidate() {},
		});
		container.addChild({
			render: renderLoadoutList,
			invalidate() {
				settingsList.invalidate();
			},
			handleInput(data: string) {
				settingsList.handleInput(data);
			},
		});
		container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));

		const helpContainer = new Container();
		const helpTitle = new Text(theme.fg("accent", theme.bold("Loadout shortcuts")), 1, 0);
		const helpBody = new Text(
			[
				theme.fg("borderAccent", "Global"),
				`  ${theme.bold("Tab")}      Switch`,
				`  ${theme.bold("↑ ↓")}      Navigate`,
				`  ${theme.bold("Type")}     Search / filter`,
				`  ${theme.bold("Esc")}      Clear search, or close picker`,
				"",
				theme.fg("borderAccent", "Tools / Skills"),
				`  ${theme.bold("Space")}    Enable / disable selected item or group`,
				`  ${theme.bold("Enter")}    Expand / collapse selected group`,
			].join("\n"),
			1,
			0,
		);
		const helpHint = new Text(theme.fg("dim", "? or Esc to close"), 1, 0);
		helpContainer.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));
		helpContainer.addChild(helpTitle);
		helpContainer.addChild(helpBody);
		helpContainer.addChild(helpHint);
		helpContainer.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));

		return {
			render: (width: number) =>
				helpVisible ? helpContainer.render(width) : container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				if (helpVisible) {
					if (data === "?" || matchesKey(data, Key.escape)) {
						helpVisible = false;
						tui.requestRender();
					}
					return;
				}

				if (data === "?") {
					helpVisible = true;
					tui.requestRender();
					return;
				}

				if (matchesKey(data, Key.tab)) {
					switchPane();
					return;
				}

				if (matchesKey(data, Key.escape)) {
					if (searchQuery !== "") {
						searchInput.setValue("");
						searchQuery = "";
						applySearch();
						return;
					}
					finish({
						enabledTools: new Set(draftEnabledTools),
						enabledSkills: new Set(draftEnabledSkills),
					});
					return;
				}

				// Navigation and toggle keys are handled by the list; everything else
				// (printable characters, word-delete, etc.) edits the search field.
				if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || data === " ") {
					settingsList.handleInput(data);
					syncSelectedIndex();
					tui.requestRender();
					return;
				}

				if (matchesKey(data, Key.enter)) {
					toggleSelectedGroupCollapse();
					return;
				}

				const before = searchInput.getValue();
				searchInput.handleInput(data);
				const after = searchInput.getValue();
				if (after !== before) {
					searchQuery = after;
					applySearch();
				} else {
					tui.requestRender();
				}
			},
		};
	}

	const LOADOUT_SUBCOMMANDS: { value: string; label: string; description: string }[] = [
		{ value: "minimal", label: "minimal", description: "Enable built-in system tools only" },
		{ value: "default", label: "default", description: "Apply saved default loadout" },
		{ value: "list", label: "list", description: "List available presets" },
		{ value: "status", label: "status", description: "Print current active tools and skills" },
		{ value: "help", label: "help", description: "Show /loadout subcommand list" },
	];

	pi.registerCommand("loadout", {
		description: "Select active tools and skills for this session",
		getArgumentCompletions: (argumentPrefix: string) => {
			const prefix = argumentPrefix.toLowerCase();
			return LOADOUT_SUBCOMMANDS.filter((item) => item.value.toLowerCase().startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const words = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const subcommand = words[0] ?? "";

			if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
				ctx.ui.notify(loadoutHelp(), "info");
				return;
			}

			if (subcommand === "status") {
				ctx.ui.notify(formatStatus(), "info");
				return;
			}

			if (subcommand === "minimal") {
				applyPreset("minimal", ctx, "/loadout minimal");
				return;
			}

			if (subcommand === "default") {
				applyDefaultLoadout(ctx, "/loadout default");
				return;
			}

			if (subcommand === "list") {
				ctx.ui.notify(formatProfileList(), "info");
				return;
			}

			if (subcommand !== "") {
				ctx.ui.notify(
					`Unknown subcommand: "${subcommand}". Try /loadout, /loadout minimal, /loadout default, /loadout list, or /loadout help.`,
					"warning",
				);
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
				createLoadoutPickerComponent(ctx, tui, theme, done, "/loadout"),
			);
		},
	});
}
