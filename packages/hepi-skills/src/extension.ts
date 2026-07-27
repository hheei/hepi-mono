import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piCaveman from "./pi-caveman/index.js";
import piPonytail from "./pi-ponytail/index.js";

export type HepiExtension = (pi: ExtensionAPI) => void;

export const hepiSkillsExtensions: readonly HepiExtension[] = [piPonytail, piCaveman];

export default function piHepiSkillsExtension(pi: ExtensionAPI): void {
	for (const extension of hepiSkillsExtensions) extension(pi);
}
