import { readFileSync } from "node:fs";
import { join } from "node:path";
import piMagicContext from "@cortexkit/pi-magic-context";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import piFff from "pi-fff";
import piWebAccess from "pi-web-access";
import { hasConfiguredPackage } from "./external-compat.js";
import { registerHePiToolsLoadoutGroups } from "./loadout-groups.js";
import piAdvisor from "./pi-advisor/index.js";
import piAsk from "./pi-ask/index.js";
import piCodexTool from "./pi-codex-tool/index.js";
import piGoal from "./pi-goal/index.js";
import piSshfs from "./pi-sshfs/index.js";
import piTodo from "./pi-todo/index.js";

export type HePiExtension = (pi: ExtensionAPI) => void;

function loadSettings(): unknown {
	try {
		return JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
	} catch {
		return undefined;
	}
}

const settings = loadSettings();
const hasFff = hasConfiguredPackage(settings, ["@ff-labs/pi-fff", "pi-fff"]);
const hasMagicContext = hasConfiguredPackage(settings, ["@cortexkit/pi-magic-context"]);
const hasWebAccess = hasConfiguredPackage(settings, ["pi-web-access"]);

export const hePiToolsExtensions: readonly HePiExtension[] = [
	registerHePiToolsLoadoutGroups,
	piAsk,
	piGoal,
	piSshfs,
	...(hasFff ? [] : [piFff]),
	piCodexTool,
	piAdvisor,
	piTodo,
	...(hasMagicContext ? [] : [piMagicContext]),
	...(hasWebAccess ? [] : [piWebAccess]),
];

export default function piHepiToolsExtension(pi: ExtensionAPI): void {
	for (const extension of hePiToolsExtensions) extension(pi);
}
