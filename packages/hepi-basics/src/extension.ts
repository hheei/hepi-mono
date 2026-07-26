import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piAutoTitle from "./auto-title/index.js";
import piBasics from "./core/index.js";
import piDollarSkill from "./dollar-skill/index.js";
import piFix from "./fix/index.js";
import piLoadout from "./loadout/index.js";
import piRtk from "./rtk/index.js";
import piT2s from "./t2s/index.js";

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
