import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import piMagicContext from "@hheei/pi-magic-context";
import {
	type HepiLoadoutGroup,
	registerHepiRuntimeLoadoutGroup,
} from "../../hepi-basics/src/core/index.js";

export type HepiExtension = (pi: ExtensionAPI) => void;

const MAGIC_CONTEXT_LOADOUT_GROUP = {
	id: "magic-context",
	label: "Magic Context",
	items: ["ctx_search", "ctx_expand", "ctx_memory", "ctx_note", "ctx_reduce", "todowrite"],
} as const satisfies HepiLoadoutGroup;

function hasConfiguredMagicContext(): boolean {
	try {
		const settings: unknown = JSON.parse(
			readFileSync(join(getAgentDir(), "settings.json"), "utf8"),
		);
		if (!settings || typeof settings !== "object" || !("packages" in settings)) return false;
		const packages = settings.packages;
		if (!Array.isArray(packages)) return false;
		return packages.some(isMagicContextPackage);
	} catch {
		return false;
	}
}

export function isMagicContextPackage(entry: unknown): boolean {
	const source =
		typeof entry === "string"
			? entry
			: entry !== null && typeof entry === "object" && "source" in entry
				? entry.source
				: undefined;
	if (typeof source !== "string") return false;
	const name = source.startsWith("npm:") ? source.slice("npm:".length) : source;
	return (
		name === "@hheei/pi-magic-context" ||
		name.startsWith("@hheei/pi-magic-context@") ||
		name === "@cortexkit/pi-magic-context" ||
		name.startsWith("@cortexkit/pi-magic-context@")
	);
}

function registerBundledMagicContext(pi: ExtensionAPI): void {
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

const hasExternalMagicContext = hasConfiguredMagicContext();

const registerExternalMagicContextLoadout: HepiExtension = (pi) => {
	if (hasExternalMagicContext) registerHepiRuntimeLoadoutGroup(pi, MAGIC_CONTEXT_LOADOUT_GROUP);
};

export const hepiMctxExtensions: readonly HepiExtension[] = [
	registerExternalMagicContextLoadout,
	...(hasExternalMagicContext ? [] : [registerBundledMagicContext]),
];

export default function piHepiMctxExtension(pi: ExtensionAPI): void {
	for (const extension of hepiMctxExtensions) extension(pi);
}
