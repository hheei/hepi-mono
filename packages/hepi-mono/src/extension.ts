import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hepiAftExtensions } from "@hheei/hepi-aft";
import piMagicContext from "@hheei/hepi-mctx";
import piSubagents from "@hheei/hepi-subagents";
import {
	type HepiLoadoutGroup,
	registerHepiRuntimeLoadoutGroup,
} from "../../hepi-basics/src/core/index.js";
import { hepiBasicsExtensions } from "../../hepi-basics/src/index.js";
import { hepiSkillsExtensions } from "../../hepi-skills/src/index.js";
import { createHepiToolsExtensions } from "../../hepi-tools/src/index.js";
import piBtw from "./pi-btw/index.js";
import piPlan from "./pi-plan/index.js";

export type HepiExtension = (pi: ExtensionAPI) => void;

const MAGIC_CONTEXT_LOADOUT_GROUP = {
	id: "magic-context",
	label: "Magic Context",
	items: ["ctx_search", "ctx_expand", "ctx_memory", "ctx_note", "ctx_reduce", "todowrite"],
} as const satisfies HepiLoadoutGroup;

function registerMagicContext(pi: ExtensionAPI): void {
	const toolNames = new Set<string>();
	const groupedPi: ExtensionAPI = {
		...pi,
		registerTool: (tool) => {
			pi.registerTool(tool);
			toolNames.add(tool.name);
		},
	};
	piMagicContext(groupedPi);
	registerHepiRuntimeLoadoutGroup(
		pi,
		toolNames.size === 0
			? MAGIC_CONTEXT_LOADOUT_GROUP
			: { ...MAGIC_CONTEXT_LOADOUT_GROUP, items: [...toolNames] },
	);
}

export const hepiExtensions: readonly HepiExtension[] = [
	...hepiBasicsExtensions,
	...createHepiToolsExtensions(),
	...hepiAftExtensions,
	registerMagicContext,
	piSubagents,
	...hepiSkillsExtensions,
	piBtw,
	piPlan,
];

export default function piHepiExtension(pi: ExtensionAPI): void {
	for (const extension of hepiExtensions) extension(pi);
}
