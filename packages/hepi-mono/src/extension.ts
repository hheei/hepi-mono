import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadAftConfig } from "../../hepi-aft/src/aft/config.js";
import { resolveHepiAftToolSurface } from "../../hepi-aft/src/aft/tool-surface.js";
import { hepiAftExtensions } from "../../hepi-aft/src/index.js";
import { hepiBasicsExtensions } from "../../hepi-basics/src/index.js";
import { hepiMctxExtensions } from "../../hepi-mctx/src/index.js";
import { hepiSkillsExtensions } from "../../hepi-skills/src/index.js";
import { createHepiToolsExtensions } from "../../hepi-tools/src/index.js";
import piBtw from "./pi-btw/index.js";
import piPlan from "./pi-plan/index.js";

export type HepiExtension = (pi: ExtensionAPI) => void;

const aftSurface = resolveHepiAftToolSurface(loadAftConfig(process.cwd()));

export const hepiExtensions: readonly HepiExtension[] = [
	...hepiBasicsExtensions,
	...createHepiToolsExtensions({
		fff: { registerRead: !aftSurface.read },
		includeCodexApplyPatch: !aftSurface.applyPatch,
	}),
	...hepiAftExtensions,
	...hepiMctxExtensions,
	...hepiSkillsExtensions,
	piBtw,
	piPlan,
];

export default function piHepiExtension(pi: ExtensionAPI): void {
	for (const extension of hepiExtensions) extension(pi);
}
