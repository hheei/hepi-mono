import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hePiBasicsExtensions } from "../../hepi-basics/src/index.js";
import { hePiSkillsExtensions } from "../../hepi-skills/src/index.js";
import { hePiToolsExtensions } from "../../hepi-tools/src/index.js";
import piBtw from "./pi-btw/index.js";
import piPlan from "./pi-plan/index.js";

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
