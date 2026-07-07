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
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	createGroupedTogglePicker,
	type ExtensionSettingsSubpanelCreateOptions,
	type GroupedTogglePickerSelection,
	type GroupedTogglePickerState,
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

		const initialEnabledTools = normalizeEnabledTools(activeToolNames());
		const initialEnabledSkills = normalizeEnabledSkills(activeSkillNames());
		const draftEnabledTools = normalizeEnabledTools(activeToolNames());
		const draftEnabledSkills = normalizeEnabledSkills(
			skillLoadoutExplicit ? enabledSkills : allSkillNames(),
		);

		function finish(result: LoadoutResult): void {
			const diff = commitLoadout(
				initialEnabledTools,
				initialEnabledSkills,
				result.enabledTools,
				result.enabledSkills,
				ctx,
				commandSource,
			);
			if (loadoutSettings.showPromptCacheWarning && hasDiff(diff)) {
				ctx.ui.notify("Loadout changed. Next response may miss prompt cache.", "warning");
			}
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

		function currentPaneState(state: GroupedTogglePickerState): LoadoutResult {
			return {
				enabledTools: normalizeEnabledTools(state.enabledIdsByPane.get("tools") ?? []),
				enabledSkills: normalizeEnabledSkills(state.enabledIdsByPane.get("skills") ?? []),
			};
		}

		function footerSelectionKind(
			selection: GroupedTogglePickerSelection | undefined,
		): LoadoutFooterSelectionKind | undefined {
			if (!selection) return undefined;
			if (selection.pane.id === "tools") return selection.kind === "group" ? "toolGroup" : "tool";
			return selection.kind === "group" ? "skillGroup" : "skill";
		}

		function footerDescription(
			selection: GroupedTogglePickerSelection | undefined,
		): string | undefined {
			if (!selection) return undefined;
			const profile = currentProfileName ?? "default";
			return `${profile} · ${selection.group.label.replace(/\s+(tools|skills)$/i, "")}`;
		}

		return createGroupedTogglePicker({
			host: tui,
			theme,
			done,
			initialPaneId: initialPane,
			helpTitle: "Loadout shortcuts",
			panes: [
				{
					id: "tools",
					label: "Tools",
					enabledIds: draftEnabledTools,
					groups: groupTools(tools).map((group) => ({
						key: group.key,
						label: group.label,
						items: group.tools.map((tool) => ({
							id: tool.name,
							label: tool.name,
							description: tool.description,
						})),
					})),
				},
				{
					id: "skills",
					label: "Skills",
					enabledIds: draftEnabledSkills,
					groups: groupSkills(skills).map((group) => ({
						key: group.key,
						label: group.label,
						items: group.skills.map((skill) => ({
							id: skill.name,
							label: skill.name,
							description: skill.description,
						})),
					})),
				},
			],
			statusLabel: formatLoadoutStatusLabel,
			groupDescription: (group, enabledCount, totalCount) =>
				formatLoadoutGroupDescription(group.label, enabledCount, totalCount),
			selectionDescription: (selection) =>
				selection.kind === "item" ? selection.item?.description : undefined,
			renderFooter: (selection, width) =>
				createLoadoutFooterLines({
					pane: (selection?.pane.id === "skills" ? "skills" : "tools") as Pane,
					selectedIndex: selection?.index ?? 0,
					total: selection?.total ?? 0,
					selectedDescription: footerDescription(selection),
					selectedSpaceAction: selection?.status === "enabled" ? "disable" : "enable",
					selectedKind: footerSelectionKind(selection),
					selectedGroupCollapsed: selection?.groupCollapsed,
					width,
					theme: {
						dim: (text) => theme.fg("dim", text),
						key: (text) => theme.fg("accent", theme.bold(text)),
					},
				}),
			onChange: (state) => {
				const next = currentPaneState(state);
				draftEnabledTools.clear();
				for (const name of next.enabledTools) draftEnabledTools.add(name);
				draftEnabledSkills.clear();
				for (const name of next.enabledSkills) draftEnabledSkills.add(name);
				applyEnabledInMemory(draftEnabledTools, draftEnabledSkills);
				updateStatus(ctx);
				saveDraftDefaultSilently();
			},
			onDone: (state) => finish(currentPaneState(state)),
			onError: (error) => {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
			},
		});
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
