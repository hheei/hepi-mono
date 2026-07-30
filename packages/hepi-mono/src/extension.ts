import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hepiAftExtensions } from "@hheei/hepi-aft";
import piMagicContext from "@hheei/hepi-mctx";
import { registerHepiSubagents } from "@hheei/hepi-subagents";
import {
	type HepiLoadoutGroup,
	registerHepiRuntimeLoadoutGroup,
} from "../../hepi-basics/src/core/index.js";
import { hepiBasicsExtensions } from "../../hepi-basics/src/index.js";
import { hepiSkillsExtensions } from "../../hepi-skills/src/index.js";
import { createHepiToolsExtensions } from "../../hepi-tools/src/index.js";
import piBtw from "./pi-btw/index.js";
import piPlan from "./pi-plan/index.js";

export type HepiExtension = (pi: ExtensionAPI) => void | Promise<void>;

const MAGIC_CONTEXT_LOADOUT_GROUP = {
	id: "magic-context",
	label: "Magic Context",
	items: ["ctx_search", "ctx_expand", "ctx_memory", "ctx_note", "ctx_reduce", "todowrite"],
} as const satisfies HepiLoadoutGroup;

const SUBAGENTS_LOADOUT_GROUP = {
	id: "subagents",
	label: "Subagents",
	items: ["agent", "get_subagent_result", "steer_subagent"],
} as const satisfies HepiLoadoutGroup;

async function registerMagicContext(pi: ExtensionAPI): Promise<void> {
	const toolNames = new Set<string>();
	const groupedPi = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
					target.registerTool(tool);
					toolNames.add(tool.name);
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as ExtensionAPI;
	await piMagicContext(groupedPi);
	registerHepiRuntimeLoadoutGroup(
		pi,
		toolNames.size === 0
			? MAGIC_CONTEXT_LOADOUT_GROUP
			: { ...MAGIC_CONTEXT_LOADOUT_GROUP, items: [...toolNames] },
	);
}

function registerSubagents(pi: ExtensionAPI): void {
	registerHepiSubagents(pi);
	registerHepiRuntimeLoadoutGroup(pi, SUBAGENTS_LOADOUT_GROUP);
}

export const hepiExtensions: readonly HepiExtension[] = [
	...hepiBasicsExtensions,
	...createHepiToolsExtensions(),
	...hepiAftExtensions,
	registerMagicContext,
	registerSubagents,
	...hepiSkillsExtensions,
	piBtw,
	piPlan,
];

export default async function piHepiExtension(pi: ExtensionAPI): Promise<void> {
	for (const extension of hepiExtensions) await extension(pi);
}
