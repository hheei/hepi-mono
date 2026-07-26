import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piCaveman from "@hheei/pi-caveman";
import piPonytail from "@hheei/pi-ponytail";

export type HePiExtension = (pi: ExtensionAPI) => void;

export const hePiSkillsExtensions: readonly HePiExtension[] = [piPonytail, piCaveman];

export default function piHepiSkillsExtension(pi: ExtensionAPI): void {
	for (const extension of hePiSkillsExtensions) extension(pi);
}
