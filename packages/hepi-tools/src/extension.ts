import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import piWebAccess from "pi-web-access";
import { hasConfiguredPackage } from "./external-compat.js";
import registerHepiFff from "./fff/index.js";
import {
	HEPI_TOOLS_LOADOUT_GROUPS,
	registerHepiToolsLoadoutGroups,
	withHepiToolLoadoutGroup,
} from "./loadout-groups.js";
import piAdvisor from "./pi-advisor/index.js";
import piAsk from "./pi-ask/index.js";
import piCodexTool from "./pi-codex-tool/index.js";
import piGoal from "./pi-goal/index.js";
import piSshfs from "./pi-sshfs/index.js";

export type HepiExtension = (pi: ExtensionAPI) => void;

function loadSettings(): unknown {
	try {
		return JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
	} catch {
		return undefined;
	}
}

const settings = loadSettings();
const hasWebAccess = hasConfiguredPackage(settings, ["pi-web-access"]);

function loadoutGroup(id: string) {
	const group = HEPI_TOOLS_LOADOUT_GROUPS.find((candidate) => candidate.id === id);
	if (group === undefined) throw new Error(`Missing HEPI tools Loadout group: ${id}`);
	return group;
}

const fffLoadoutGroup = loadoutGroup("fff");
const webSearchLoadoutGroup = loadoutGroup("web-search");

const registerHepiFffWithLoadout = withHepiToolLoadoutGroup(registerHepiFff, fffLoadoutGroup, [
	"find",
]);
const registerBundledWebAccess = withHepiToolLoadoutGroup(piWebAccess, webSearchLoadoutGroup);

const registerExternalToolLoadoutGroups: HepiExtension = (pi) => {
	registerHepiToolsLoadoutGroups(pi, [...(hasWebAccess ? [webSearchLoadoutGroup] : [])]);
};

export const hepiToolsExtensions: readonly HepiExtension[] = [
	registerExternalToolLoadoutGroups,
	piAsk,
	piGoal,
	piSshfs,
	registerHepiFffWithLoadout,
	piCodexTool,
	piAdvisor,
	...(hasWebAccess ? [] : [registerBundledWebAccess]),
];

export default function piHepiToolsExtension(pi: ExtensionAPI): void {
	for (const extension of hepiToolsExtensions) extension(pi);
}
