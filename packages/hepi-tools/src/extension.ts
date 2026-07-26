import piMagicContext from "@cortexkit/pi-magic-context";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piFff from "pi-fff";
import piWebAccess from "pi-web-access";
import piAdvisor from "./pi-advisor/index.js";
import piAsk from "./pi-ask/index.js";
import piCodexTool from "./pi-codex-tool/index.js";
import piGoal from "./pi-goal/index.js";
import piSshfs from "./pi-sshfs/index.js";
import piTodo from "./pi-todo/index.js";

export type HePiExtension = (pi: ExtensionAPI) => void;

export const hePiToolsExtensions: readonly HePiExtension[] = [
	piAsk,
	piGoal,
	piSshfs,
	piFff,
	piCodexTool,
	piAdvisor,
	piTodo,
	piMagicContext,
	piWebAccess,
];

export default function piHepiToolsExtension(pi: ExtensionAPI): void {
	for (const extension of hePiToolsExtensions) extension(pi);
}
