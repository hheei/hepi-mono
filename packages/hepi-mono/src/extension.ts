import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hepiBasicsExtensions } from "../../hepi-basics/src/index.js";
import { hepiSkillsExtensions } from "../../hepi-skills/src/index.js";
import { hepiToolsExtensions } from "../../hepi-tools/src/index.js";
import piBtw from "./pi-btw/index.js";
import piPlan from "./pi-plan/index.js";

export type HepiExtension = (pi: ExtensionAPI) => void;

export const hepiExtensions: readonly HepiExtension[] = [
	...hepiBasicsExtensions,
	...hepiToolsExtensions,
	...hepiSkillsExtensions,
	piBtw,
	piPlan,
];

export default function piHepiExtension(pi: ExtensionAPI): void {
	for (const extension of hepiExtensions) extension(pi);
}
