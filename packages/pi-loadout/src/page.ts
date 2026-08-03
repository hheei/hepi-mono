import type {
	ExtensionAPI,
	SlashCommandInfo,
	Theme,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type ExtensionPageView,
	type ExtensionPageViewContext,
	type LoadoutInventoryItem,
	type LoadoutResourceMetadata,
	type LoadoutToolMetadata,
	observeLoadoutInventory,
	type PiSettingsPaths,
} from "@hheei/pi-ext-core";
import { type LoadoutEngine, loadoutToolPolicies } from "./engine.js";
import {
	type LoadoutConfiguration,
	type LoadoutDelta,
	type LoadoutScope,
	type LoadoutSelection,
	resolveActiveToolNames,
	resolveLoadoutState,
	skillConfigurationKey,
	toolConfigurationKey,
} from "./model.js";
import { applyLoadoutSelection, updateLoadoutSelections } from "./storage.js";

// The router guarantees this many rows; keeping it fixed prevents Description length from moving hints.
const PANEL_ROWS = 20;
const LIST_HEADER_ROWS = 2;
const LIST_HINT_ROWS = 1;
const VISIBLE_ROWS = PANEL_ROWS - LIST_HEADER_ROWS - LIST_HINT_ROWS;

interface ResourceItem {
	readonly key: string;
	readonly name: string;
	readonly kind: string;
	readonly description: string;
	readonly displayGroup: string;
	readonly origin: string;
	readonly defaultActive: boolean;
	readonly projectPrivate: boolean;
	readonly enabled: boolean;
	readonly lockedBy?: string;
}

interface DraftSelection {
	readonly key: string;
	readonly selection: LoadoutSelection;
	readonly defaultActive: boolean;
	readonly projectPrivate: boolean;
}

type ListEntry =
	| { readonly kind: "group"; readonly label: string }
	| { readonly kind: "item"; readonly item: ResourceItem };

export interface LoadoutPageOptions {
	/** Test/embedding override; normal Pi sessions use standard global/project paths. */
	readonly paths?: PiSettingsPaths;
}

function readableError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function cloneDelta(delta: LoadoutDelta): LoadoutDelta {
	return { disabled: [...delta.disabled], enabled: [...delta.enabled] };
}

function cloneConfiguration(configuration: LoadoutConfiguration): LoadoutConfiguration {
	return { global: cloneDelta(configuration.global), project: cloneDelta(configuration.project) };
}

function sourceLabel(source: string): string {
	if (source === "builtin") return "Built-in";
	if (source === "extension") return "Extension";
	return "Third-party";
}

function scopeLabel(scope: LoadoutScope, cwd: string): string {
	return scope === "global"
		? "Global · ~/.pi/agent/settings.json"
		: `Project · ${cwd}/.pi/settings.json`;
}

function rawSelection(
	item: Pick<ResourceItem, "key" | "defaultActive" | "projectPrivate">,
	scope: LoadoutScope,
	configuration: LoadoutConfiguration,
): LoadoutSelection {
	const delta = configuration[scope];
	if (delta.disabled.includes(item.key)) return "disabled";
	if (delta.enabled.includes(item.key)) return "enabled";
	if (scope === "project" && !item.projectPrivate) return "inherit";
	return item.defaultActive ? "enabled" : "disabled";
}

function nextSelection(
	item: Pick<ResourceItem, "key" | "defaultActive" | "projectPrivate">,
	scope: LoadoutScope,
	configuration: LoadoutConfiguration,
): LoadoutSelection {
	const current = rawSelection(item, scope, configuration);
	if (scope === "project" && !item.projectPrivate) {
		return current === "inherit" ? "enabled" : current === "enabled" ? "disabled" : "inherit";
	}
	return current === "enabled" ? "disabled" : "enabled";
}

function applyDraft(
	configuration: LoadoutConfiguration,
	scope: LoadoutScope,
	draft: DraftSelection,
): LoadoutConfiguration {
	const delta = applyLoadoutSelection(cloneDelta(configuration[scope]), { ...draft, scope });
	return scope === "global"
		? { global: delta, project: cloneDelta(configuration.project) }
		: { global: cloneDelta(configuration.global), project: delta };
}

function pad(value: string, width: number): string {
	return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function wrapDescription(text: string, width: number): readonly string[] {
	const lines: string[] = [];
	for (const word of text.split(/\s+/u)) {
		const previous = lines.at(-1);
		if (previous === undefined || visibleWidth(`${previous} ${word}`) > width) lines.push(word);
		else lines[lines.length - 1] = `${previous} ${word}`;
	}
	return lines;
}

function scrollbar(total: number, top: number, theme: Theme): readonly string[] {
	if (total <= VISIBLE_ROWS) return Array.from({ length: PANEL_ROWS }, () => "");
	const track = VISIBLE_ROWS;
	const thumbHeight = Math.max(1, Math.round((track * VISIBLE_ROWS) / total));
	const maxTop = Math.max(1, total - VISIBLE_ROWS);
	const thumbTop = Math.round(((track - thumbHeight) * top) / maxTop);
	// Header and hint rows have no rail; only the list viewport receives the vertical indicator.
	return Array.from({ length: PANEL_ROWS }, (_, index) => {
		const trackIndex = index - LIST_HEADER_ROWS;
		return trackIndex >= thumbTop && trackIndex < thumbTop + thumbHeight
			? theme.fg("text", "█")
			: trackIndex >= 0 && trackIndex < track
				? theme.fg("muted", "│")
				: "";
	});
}

function toolItem(
	tool: ToolInfo,
	metadata: LoadoutToolMetadata | undefined,
	initialActive: ReadonlySet<string>,
	configuration: LoadoutConfiguration,
	activeToolNames: ReadonlySet<string>,
	allPolicies: ReturnType<typeof loadoutToolPolicies>,
): ResourceItem {
	const defaultActive = metadata?.defaultActive ?? initialActive.has(tool.name);
	const key = toolConfigurationKey(tool.name);
	const state = resolveLoadoutState(key, defaultActive, configuration);
	const policy = allPolicies.find((candidate) => candidate.name === tool.name);
	const lockedBy =
		state.enabled && !activeToolNames.has(tool.name)
			? allPolicies.find(
					(candidate) =>
						activeToolNames.has(candidate.name) &&
						candidate.conflictSets.some((set) => policy?.conflictSets.includes(set)),
				)?.name
			: undefined;
	return {
		key,
		name: tool.name,
		kind: "tool",
		description: tool.description,
		displayGroup: metadata?.group ?? sourceLabel(tool.sourceInfo.source),
		origin: sourceLabel(tool.sourceInfo.source),
		defaultActive,
		projectPrivate: tool.sourceInfo.scope === "project",
		enabled: state.enabled && lockedBy === undefined,
		...(lockedBy === undefined ? {} : { lockedBy }),
	};
}

function skillItem(skill: SlashCommandInfo, configuration: LoadoutConfiguration): ResourceItem {
	const key = skillConfigurationKey(skill.name);
	const state = resolveLoadoutState(key, true, configuration);
	return {
		key,
		name: skill.name.replace(/^skill:/u, ""),
		kind: "skill",
		description: skill.description ?? "Skill prompt available to the current Pi session.",
		displayGroup: "",
		origin: sourceLabel(skill.sourceInfo.source),
		defaultActive: true,
		projectPrivate: skill.sourceInfo.scope === "project",
		enabled: state.enabled,
	};
}

function resourceItem(
	resource: LoadoutResourceMetadata,
	configuration: LoadoutConfiguration,
): ResourceItem {
	const state = resolveLoadoutState(resource.id, resource.defaultActive, configuration);
	return {
		key: resource.id,
		name: resource.label,
		kind: resource.kind,
		description: resource.description,
		displayGroup: resource.summary,
		origin: resource.owner,
		defaultActive: resource.defaultActive,
		projectPrivate: resource.projectPrivate,
		enabled: state.enabled,
	};
}

/** Owns only the Loadout page draft and rendering; engine remains the activation-policy owner. */
export function createLoadoutPage(
	pi: ExtensionAPI,
	engine: LoadoutEngine,
	context: ExtensionPageViewContext,
	options: LoadoutPageOptions = {},
): ExtensionPageView {
	const snapshot = engine.snapshot();
	if (snapshot === undefined) throw new Error("Loadout engine is not active");
	let theme = context.theme;
	let scope: LoadoutScope = "global";
	let configuration = cloneConfiguration(snapshot.configuration);
	let metadata: readonly LoadoutInventoryItem[] = [];
	let search = "";
	let selected = 0;
	let scrollTop = 0;
	let changed = false;
	let closed = false;
	const drafts = new Map<LoadoutScope, Map<string, DraftSelection>>();
	const initialActive = new Set(snapshot.initialActiveToolNames);

	observeLoadoutInventory(pi, {
		signal: context.signal,
		onChange(items) {
			metadata = items;
			context.requestRender();
		},
	});

	const resources = (): readonly ResourceItem[] => {
		const tools = pi.getAllTools();
		const toolMetadata = metadata.filter((item): item is LoadoutToolMetadata => !("kind" in item));
		const toolMetadataById = new Map(toolMetadata.map((item) => [item.id, item]));
		const policies = loadoutToolPolicies(tools, initialActive, toolMetadata);
		const active = new Set(resolveActiveToolNames(policies, configuration));
		const items = [
			...tools.map((tool) =>
				toolItem(
					tool,
					toolMetadataById.get(tool.name),
					initialActive,
					configuration,
					active,
					policies,
				),
			),
			...metadata
				.filter((item): item is LoadoutResourceMetadata => "kind" in item)
				.map((item) => resourceItem(item, configuration)),
			...pi
				.getCommands()
				.filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
				.map((command) => skillItem(command, configuration)),
		];
		const query = search.trim().toLocaleLowerCase();
		return items
			.filter((item) => scope === "project" || !item.projectPrivate)
			.filter(
				(item) => !query || `${item.name} ${item.displayGroup}`.toLocaleLowerCase().includes(query),
			)
			.sort((left, right) => {
				// Preserve Tools/Skills sections, but make native resources discoverable before extensions.
				const kindOrder =
					(left.kind === "tool" ? 0 : left.kind === "skill" ? 1 : 2) -
					(right.kind === "tool" ? 0 : right.kind === "skill" ? 1 : 2);
				const builtInOrder =
					Number(left.origin !== "Built-in") - Number(right.origin !== "Built-in");
				return (
					kindOrder ||
					(left.kind !== "tool" && left.kind !== "skill"
						? left.name.localeCompare(right.name)
						: 0) ||
					builtInOrder ||
					left.displayGroup.localeCompare(right.displayGroup) ||
					left.name.localeCompare(right.name)
				);
			});
	};

	const entries = (): readonly ListEntry[] => {
		const items = resources();
		const tools = items.filter((item) => item.kind === "tool");
		const skills = items.filter((item) => item.kind === "skill");
		const agents = items.filter((item) => item.kind !== "tool" && item.kind !== "skill");
		return [
			...(tools.length === 0
				? []
				: [
						{ kind: "group" as const, label: "⚒ Tools" },
						...tools.map((item) => ({ kind: "item" as const, item })),
					]),
			...(skills.length === 0
				? []
				: [
						{ kind: "group" as const, label: "✦ Skills" },
						...skills.map((item) => ({ kind: "item" as const, item })),
					]),
			...(agents.length === 0
				? []
				: [
						{ kind: "group" as const, label: "𖠌 Agents" },
						...agents.map((item) => ({ kind: "item" as const, item })),
					]),
		];
	};
	const selectedItem = (): ResourceItem | undefined => resources()[selected];
	const currentDraft = (): Map<string, DraftSelection> => {
		const existing = drafts.get(scope);
		if (existing !== undefined) return existing;
		const created = new Map<string, DraftSelection>();
		drafts.set(scope, created);
		return created;
	};
	const flush = async (): Promise<void> => {
		const draft = drafts.get(scope);
		if (draft === undefined || draft.size === 0) return;
		const selections = [...draft.values()];
		try {
			await updateLoadoutSelections({
				cwd: context.command.cwd,
				...(options.paths === undefined ? {} : { paths: options.paths }),
				scope,
				selections,
				signal: context.signal,
			});
			for (const selection of selections)
				configuration = applyDraft(configuration, scope, selection);
			drafts.delete(scope);
			changed = true;
		} catch (error: unknown) {
			drafts.delete(scope);
			context.command.ui.notify(
				`Loadout changes were not saved: ${readableError(error)}`,
				"warning",
			);
		}
	};
	const move = (offset: number): void => {
		const items = resources();
		if (items.length === 0) return;
		selected = Math.max(0, Math.min(items.length - 1, selected + offset));
	};
	const toggle = (): void => {
		const item = selectedItem();
		if (item === undefined || item.lockedBy !== undefined) return;
		const selection = nextSelection(item, scope, configuration);
		const draft: DraftSelection = {
			key: item.key,
			selection,
			defaultActive: item.defaultActive,
			projectPrivate: item.projectPrivate,
		};
		configuration = applyDraft(configuration, scope, draft);
		if (selection === rawSelection(item, scope, snapshot.configuration)) {
			const current = drafts.get(scope);
			current?.delete(item.key);
			if (current?.size === 0) drafts.delete(scope);
		} else currentDraft().set(item.key, draft);
		context.requestRender();
	};
	const leave = async (nextScope?: LoadoutScope): Promise<void> => {
		await flush();
		if (nextScope === undefined) context.requestClose();
		else {
			scope = nextScope;
			selected = 0;
			scrollTop = 0;
			context.requestRender();
		}
	};

	return {
		minRows: 20,
		component: {
			render(width: number): string[] {
				const items = resources();
				if (selected >= items.length) selected = Math.max(0, items.length - 1);
				const allEntries = entries();
				const selectedEntry = allEntries.findIndex(
					(entry) => entry.kind === "item" && entry.item.key === selectedItem()?.key,
				);
				if (selectedEntry >= 0) {
					// Keep keyboard navigation centered until the viewport reaches either list boundary.
					const maxTop = Math.max(0, allEntries.length - VISIBLE_ROWS);
					scrollTop = Math.min(maxTop, Math.max(0, selectedEntry - Math.floor(VISIBLE_ROWS / 2)));
				}
				const maxTop = Math.max(0, allEntries.length - VISIBLE_ROWS);
				scrollTop = Math.min(scrollTop, maxTop);
				const wide = width >= 76;
				const listWidth = wide ? Math.max(34, Math.floor(width * 0.56)) : width;
				const scrollbarWidth = allEntries.length > VISIBLE_ROWS ? 2 : 0;
				const descriptionWidth = wide ? Math.max(0, width - listWidth - scrollbarWidth - 3) : 0;
				// Keep both columns stable while scrolling, without using spare width to push groups right.
				const widestName = Math.max(8, ...items.map((item) => visibleWidth(item.name)));
				const nameWidth = Math.min(widestName, Math.max(8, Math.floor(listWidth * 0.55)));
				const groupWidth = Math.max(1, listWidth - nameWidth - 5);
				const visibleEntries = allEntries.slice(scrollTop, scrollTop + VISIBLE_ROWS);
				const list = [
					theme.fg("muted", truncateToWidth(scopeLabel(scope, context.command.cwd), listWidth)),
					// Reserve one cell after the query so a full search does not touch the list boundary.
					`> ${truncateToWidth(search || "_", Math.max(0, listWidth - 3))} `,
					...visibleEntries.map((entry) => {
						if (entry.kind === "group") return theme.bold(truncateToWidth(entry.label, listWidth));
						const item = entry.item;
						const status = item.lockedBy !== undefined ? "⊘" : item.enabled ? "●" : "○";
						const selectedRow = item.key === selectedItem()?.key;
						const plain = `${selectedRow ? "→" : " "} ${status} ${pad(truncateToWidth(item.name, nameWidth), nameWidth)} ${truncateToWidth(item.displayGroup, groupWidth)}`;
						const styled =
							item.lockedBy !== undefined
								? theme.fg("dim", plain)
								: selectedRow
									? theme.fg("accent", theme.bold(plain))
									: plain;
						return truncateToWidth(styled, listWidth);
					}),
				];
				// Fill the viewport, then pin interaction hints to the final panel row.
				while (list.length < PANEL_ROWS - LIST_HINT_ROWS) list.push("");
				list.push(
					theme.fg(
						"dim",
						`↕ navigate · ^p ${scope === "global" ? "project" : "global"} · ␣ change · ⎋ ${search ? "clear" : "close"}`,
					),
				);
				const selectedResource = selectedItem();
				const description =
					selectedResource === undefined
						? [theme.fg("muted", search ? "No matching resources." : "No resources in this scope.")]
						: [
								theme.bold(
									truncateToWidth(
										`${selectedResource.name} (${selectedResource.kind})`,
										descriptionWidth,
									),
								),
								"",
								...wrapDescription(selectedResource.description, descriptionWidth),
								"",
								theme.fg("muted", `Origin: ${selectedResource.origin}`),
								theme.fg(
									"muted",
									`Status: ${selectedResource.lockedBy === undefined ? (selectedResource.enabled ? "● active" : "○ disabled") : "⊘ locked"}`,
								),
								...(selectedResource.lockedBy === undefined
									? []
									: [
											theme.fg(
												"dim",
												`Locked by ${selectedResource.lockedBy}. Change its winning override first.`,
											),
										]),
							];
				if (!wide) return [...list, "", ...description].map((line) => truncateToWidth(line, width));
				// The Description is intentionally read only within the fixed panel height.
				const rail = scrollbar(allEntries.length, scrollTop, theme);
				return Array.from({ length: PANEL_ROWS }, (_, index) => {
					const left = pad(truncateToWidth(list[index] ?? "", listWidth), listWidth);
					return `${left}${pad(rail[index] ?? "", scrollbarWidth)}   ${truncateToWidth(description[index] ?? "", descriptionWidth)}`;
				});
			},
			handleInput(): void {},
			invalidate(): void {
				context.requestRender();
			},
		},
		async handleInput(input: string): Promise<boolean> {
			// matchesKey accepts both legacy control bytes and terminals' CSI-u Ctrl+P sequence.
			if (matchesKey(input, "ctrl+p")) {
				await leave(scope === "global" ? "project" : "global");
				return true;
			}
			if (matchesKey(input, Key.left) || matchesKey(input, Key.right)) {
				await flush();
				return false;
			}
			if (matchesKey(input, Key.escape)) {
				if (search) {
					search = "";
					selected = 0;
					context.requestRender();
				} else await leave();
				return true;
			}
			if (matchesKey(input, Key.up)) move(-1);
			else if (matchesKey(input, Key.down)) move(1);
			else if (matchesKey(input, Key.space)) toggle();
			else if (matchesKey(input, Key.backspace)) search = search.slice(0, -1);
			else if (input && !input.startsWith("\x1b") && !/\p{Cc}/u.test(input)) search += input;
			context.requestRender();
			return true;
		},
		onThemeChange(nextTheme: Theme): void {
			theme = nextTheme;
		},
		close(): void {
			if (closed) return;
			closed = true;
			if (changed) context.command.ui.notify("※ Reload to apply Loadout changes.", "info");
		},
	};
}
