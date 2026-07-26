import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hePiBasicsExtensions } from "@hheei/hepi-basics";
import { hePiSkillsExtensions } from "@hheei/hepi-skills";
import { hePiToolsExtensions } from "@hheei/hepi-tools";
import piBtw from "@hheei/pi-btw";
import piPlan from "@hheei/pi-plan";

export type HePiExtension = (pi: ExtensionAPI) => void;

export const hePiExtensions: readonly HePiExtension[] = [
	...hePiBasicsExtensions,
	...hePiToolsExtensions,
	...hePiSkillsExtensions,
	piBtw,
	piPlan,
];

export default function piHepiExtension(pi: ExtensionAPI): void {
	for (const extension of hePiExtensions) extension(pi);
}
