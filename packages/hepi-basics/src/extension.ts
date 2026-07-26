import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piAutoTitle from "@hheei/pi-auto-title";
import piBasics from "@hheei/pi-basics";
import piDollarSkill from "@hheei/pi-dollar-skill";
import piFix from "@hheei/pi-fix";
import piLoadout from "@hheei/pi-loadout";
import piRtk from "@hheei/pi-rtk";
import piT2s from "@hheei/pi-t2s";

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
