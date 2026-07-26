import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piAutoTitle from "./pi-auto-title/index.js";
import piBasics from "./pi-basics/index.js";
import piDollarSkill from "./pi-dollar-skill/index.js";
import piFix from "./pi-fix/index.js";
import piLoadout from "./pi-loadout/index.js";
import piRtk from "./pi-rtk/index.js";
import piT2s from "./pi-t2s/index.js";

export type HePiExtension = (pi: ExtensionAPI) => void;

export const hePiBasicsExtensions: readonly HePiExtension[] = [
	piBasics,
	piLoadout,
	piRtk,
	piDollarSkill,
	piFix,
	piT2s,
	piAutoTitle,
];

export default function piHepiBasicsExtension(pi: ExtensionAPI): void {
	for (const extension of hePiBasicsExtensions) extension(pi);
}
