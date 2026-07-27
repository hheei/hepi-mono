import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { HepiLoadoutGroup } from "../core/index.js";
import {
	type LoadoutDescriptionRegistry,
	type LoadoutItem,
	type LoadoutKey,
	type LoadoutSourceScope,
	loadoutKey,
	sortLoadoutItems,
} from "./model.js";

export interface LoadoutInventory {
	readonly items: readonly LoadoutItem[];
}
export type LoadoutInventoryValue = LoadoutInventory | readonly LoadoutItem[];
export interface LoadoutInventoryProvider {
	load(signal?: AbortSignal): LoadoutInventoryValue | Promise<LoadoutInventoryValue>;
}
export type ToolDefinitionLookup = { readonly promptSnippet?: string };
export interface LoadoutCommandInfo {
	readonly name: string;
	readonly description?: string;
	readonly source: string;
	readonly sourceInfo: {
		readonly source: string;
		readonly scope: string;
		readonly path: string;
		readonly origin: string;
	};
}
export interface LoadoutInventorySource {
	readonly getAllTools?: () => readonly ToolInfo[];
	readonly getCommands?: () => readonly LoadoutCommandInfo[];
	readonly getToolDefinition?: (name: string) => ToolDefinitionLookup | undefined;
	readonly descriptionRegistry?: LoadoutDescriptionRegistry;
	readonly getLoadoutGroups?: () => readonly HepiLoadoutGroup[];
}
const BUILTIN_PROMPT_SNIPPETS: Readonly<Record<string, string>> = {
	bash: "Execute bash commands (ls, grep, find, etc.)",
	edit: "Make precise file edits with exact text replacement, including multiple disjoint changes in one call",
	find: "Find files by glob pattern (respects .gitignore)",
	grep: "Search file contents for patterns (respects .gitignore)",
	ls: "List directory contents",
	read: "Read file contents",
	write: "Create or overwrite files",
};

interface LoadoutInventorySnapshot {
	readonly tools: readonly ToolInfo[];
	readonly commands: readonly LoadoutCommandInfo[];
	readonly groups: readonly HepiLoadoutGroup[];
	readonly promptSnippets: ReadonlyMap<string, string | undefined>;
	readonly descriptions: LoadoutDescriptionRegistry | undefined;
}

function sourceScope(scope: string, source: string): LoadoutSourceScope {
	if (source === "builtin" || source === "core") return "global";
	return scope === "project" || scope === "temporary" ? "project" : "global";
}

function estimateTokenCount(value: string): number {
	return Math.max(1, Math.ceil(value.length / 4));
}
function readSkillInstruction(path: string): string | undefined {
	try {
		const text = readFileSync(path, "utf8");
		const body = text.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/)?.[1] ?? text;
		return body.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function readSkillInstructionAsync(path: string): Promise<string | undefined> {
	try {
		const text = await readFile(path, "utf8");
		const body = text.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/)?.[1] ?? text;
		return body.trim() || undefined;
	} catch {
		return undefined;
	}
}
function toolTokenCount(tool: ToolInfo, promptSnippet: string | undefined): number {
	const schema = JSON.stringify(tool.parameters);
	return estimateTokenCount(
		[tool.name, promptSnippet, schema, ...(tool.promptGuidelines ?? [])].filter(Boolean).join("\n"),
	);
}

function toolItem(
	tool: ToolInfo,
	getPromptSnippet: (name: string) => string | undefined,
	getDescriptionPanel: (
		item: Pick<LoadoutItem, "key" | "kind" | "name">,
	) => LoadoutItem["descriptionPanel"],
): LoadoutItem {
	const scope = sourceScope(tool.sourceInfo.scope, tool.sourceInfo.source);
	const promptSnippet = getPromptSnippet(tool.name);
	return {
		key: loadoutKey("tool", tool.name, tool.sourceInfo.source),
		name: tool.name,
		kind: "tool",
		sourceScope: scope,
		hasGlobalDefinition: scope === "global",
		origin: tool.sourceInfo.source,
		description: promptSnippet,
		instruction: tool.promptGuidelines?.join("\n"),
		descriptionPanel: getDescriptionPanel({
			key: loadoutKey("tool", tool.name, tool.sourceInfo.source),
			kind: "tool",
			name: tool.name,
		}),
		tokenCount: toolTokenCount(tool, promptSnippet),
		conflictGroup: `tool:${tool.name}`,
	};
}

function belongsToGroup(item: LoadoutItem, group: HepiLoadoutGroup): boolean {
	if (item.kind !== "tool") return false;
	const selectors = group.items ?? [];
	return selectors.some((selector) => selector === item.key || selector === item.name);
}

function applyLoadoutGroup(item: LoadoutItem, groups: readonly HepiLoadoutGroup[]): LoadoutItem {
	const group = groups.find((candidate) => belongsToGroup(item, candidate));
	return group === undefined ? item : { ...item, group: group.label };
}

function skillItem(
	name: string,
	description: string | undefined,
	source: string,
	instruction: string | undefined,
	getDescriptionPanel: (
		item: Pick<LoadoutItem, "key" | "kind" | "name">,
	) => LoadoutItem["descriptionPanel"],
): LoadoutItem {
	return {
		key: loadoutKey("skill", name, source),
		name,
		kind: "skill",
		sourceScope: "global",
		hasGlobalDefinition: true,
		origin: source,
		description,
		instruction,
		descriptionPanel: getDescriptionPanel({
			key: loadoutKey("skill", name, source),
			kind: "skill",
			name,
		}),
		tokenCount: estimateTokenCount([name, description, instruction].filter(Boolean).join("\n")),
	};
}

function skillCommands(snapshot: LoadoutInventorySnapshot): readonly LoadoutCommandInfo[] {
	return snapshot.commands.filter(
		(command) => command.source === "skill" && command.name.startsWith("skill:"),
	);
}

function captureLoadoutInventory(
	pi: LoadoutInventorySource,
	groupsOverride?: () => readonly HepiLoadoutGroup[],
): LoadoutInventorySnapshot {
	const tools = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
	return {
		tools,
		commands: typeof pi.getCommands === "function" ? pi.getCommands() : [],
		groups: groupsOverride?.() ?? pi.getLoadoutGroups?.() ?? [],
		promptSnippets: new Map(
			tools.map((tool) => [
				tool.name,
				pi.getToolDefinition?.(tool.name)?.promptSnippet ?? BUILTIN_PROMPT_SNIPPETS[tool.name],
			]),
		),
		descriptions: pi.descriptionRegistry,
	};
}

async function inventoryFingerprint(snapshot: LoadoutInventorySnapshot): Promise<string> {
	const skillPaths = [
		...new Set(skillCommands(snapshot).map((command) => command.sourceInfo.path)),
	];
	const skillVersions = await Promise.all(
		skillPaths.map(async (path) => {
			try {
				const info = await stat(path);
				return [path, info.mtimeMs, info.size];
			} catch {
				return [path, null, null];
			}
		}),
	);
	return JSON.stringify({
		tools: snapshot.tools.map((tool) => [
			tool.name,
			tool.description,
			tool.sourceInfo.scope,
			tool.sourceInfo.source,
			tool.sourceInfo.path,
			tool.promptGuidelines,
			snapshot.promptSnippets.get(tool.name),
		]),
		commands: snapshot.commands.map((command) => [
			command.name,
			command.description,
			command.source,
			command.sourceInfo.scope,
			command.sourceInfo.source,
			command.sourceInfo.path,
		]),
		groups: snapshot.groups.map((group) => [group.id, group.label, group.items]),
		skillVersions,
	});
}

function createLoadoutInventoryFromSnapshot(
	snapshot: LoadoutInventorySnapshot,
	getSkillInstruction: (path: string) => string | undefined,
): LoadoutInventory {
	const items = new Map<LoadoutKey, LoadoutItem>();
	const { groups, descriptions } = snapshot;
	const getPromptSnippet = (name: string): string | undefined => snapshot.promptSnippets.get(name);
	const getDescriptionPanel = (item: Pick<LoadoutItem, "key" | "kind" | "name">) =>
		descriptions?.get(item);
	for (const tool of snapshot.tools) {
		const item = applyLoadoutGroup(toolItem(tool, getPromptSnippet, getDescriptionPanel), groups);
		items.set(item.key, item);
	}
	for (const command of skillCommands(snapshot)) {
		const name = command.name.slice("skill:".length);
		if (!name) continue;
		const key = loadoutKey("skill", name, command.sourceInfo.source);
		const item = skillItem(
			name,
			command.description,
			command.sourceInfo.source,
			getSkillInstruction(command.sourceInfo.path),
			getDescriptionPanel,
		);
		items.set(key, applyLoadoutGroup(item, groups));
	}
	return { items: sortLoadoutItems([...items.values()]) };
}

export function createLoadoutInventory(pi: LoadoutInventorySource): LoadoutInventory {
	return createLoadoutInventoryFromSnapshot(captureLoadoutInventory(pi), readSkillInstruction);
}

async function createAsyncLoadoutInventory(
	snapshot: LoadoutInventorySnapshot,
): Promise<LoadoutInventory> {
	const paths = [...new Set(skillCommands(snapshot).map((command) => command.sourceInfo.path))];
	const instructions = new Map<string, string | undefined>();
	let nextPath = 0;
	const workers = Array.from({ length: Math.min(8, paths.length) }, async () => {
		while (nextPath < paths.length) {
			const path = paths[nextPath++];
			if (path === undefined) continue;
			instructions.set(path, await readSkillInstructionAsync(path));
		}
	});
	await Promise.all(workers);
	return createLoadoutInventoryFromSnapshot(snapshot, (path) => instructions.get(path));
}

export function createLoadoutInventoryProvider(
	pi: LoadoutInventorySource,
	getLoadoutGroups?: () => readonly HepiLoadoutGroup[],
): LoadoutInventoryProvider {
	let cached: { readonly fingerprint: string; readonly inventory: LoadoutInventory } | undefined;
	const pending = new Map<string, Promise<LoadoutInventory>>();
	return {
		load: async (signal) => {
			signal?.throwIfAborted();
			const snapshot = captureLoadoutInventory(pi, getLoadoutGroups);
			const fingerprint = await inventoryFingerprint(snapshot);
			const inventory =
				cached?.fingerprint === fingerprint
					? cached.inventory
					: await (pending.get(fingerprint) ??
							(() => {
								const loading = createAsyncLoadoutInventory(snapshot).then((loaded) => {
									cached = { fingerprint, inventory: loaded };
									return loaded;
								});
								pending.set(fingerprint, loading);
								void loading.then(
									() => pending.delete(fingerprint),
									() => pending.delete(fingerprint),
								);
								return loading;
							})());
			signal?.throwIfAborted();
			return inventory;
		},
	};
}

export function createMcpPlaceholder(
	name: string,
	description?: string,
	origin = "MCP placeholder",
): LoadoutItem {
	return {
		key: loadoutKey("mcp", name, origin),
		name,
		kind: "mcp",
		sourceScope: "global",
		hasGlobalDefinition: true,
		origin,
		description,
	};
}

export function mergeLoadoutInventory(
	native: LoadoutInventory,
	placeholders: readonly LoadoutItem[] = [],
): LoadoutInventory {
	const items = new Map(native.items.map((item) => [item.key, item]));
	for (const item of placeholders) if (!items.has(item.key)) items.set(item.key, item);
	return { items: sortLoadoutItems([...items.values()]) };
}
