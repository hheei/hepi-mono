import { readFileSync } from "node:fs";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
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

export function createLoadoutInventory(pi: LoadoutInventorySource): LoadoutInventory {
	const items = new Map<LoadoutKey, LoadoutItem>();
	const descriptions = pi.descriptionRegistry;
	const getPromptSnippet = (name: string): string | undefined =>
		pi.getToolDefinition?.(name)?.promptSnippet ?? BUILTIN_PROMPT_SNIPPETS[name];
	const getDescriptionPanel = (item: Pick<LoadoutItem, "key" | "kind" | "name">) =>
		descriptions?.get(item);
	const tools = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
	for (const tool of tools) {
		const item = toolItem(tool, getPromptSnippet, getDescriptionPanel);
		items.set(item.key, item);
	}
	const commands = typeof pi.getCommands === "function" ? pi.getCommands() : [];
	for (const command of commands) {
		if (command.source !== "skill" || !command.name.startsWith("skill:")) continue;
		const name = command.name.slice("skill:".length);
		if (!name) continue;
		const key = loadoutKey("skill", name, command.sourceInfo.source);
		items.set(
			key,
			skillItem(
				name,
				command.description,
				command.sourceInfo.source,
				readSkillInstruction(command.sourceInfo.path),
				getDescriptionPanel,
			),
		);
	}
	return { items: sortLoadoutItems([...items.values()]) };
}
export function createLoadoutInventoryProvider(
	pi: LoadoutInventorySource,
): LoadoutInventoryProvider {
	return {
		load: (signal) => {
			signal?.throwIfAborted();
			const inventory = createLoadoutInventory(pi);
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
