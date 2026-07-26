import piMagicContext from "@cortexkit/pi-magic-context";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piAdvisor from "@hheei/pi-advisor";
import piAsk from "@hheei/pi-ask";
import piCodexTool from "@hheei/pi-codex-tool";
import piGoal from "@hheei/pi-goal";
import piSshfs from "@hheei/pi-sshfs";
import piTodo from "@hheei/pi-todo";
import piFff from "pi-fff";
import piWebAccess from "pi-web-access";

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
