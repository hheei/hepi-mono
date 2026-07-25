import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piAdvisor from "@hheei/pi-advisor";
import piAsk from "@hheei/pi-ask";
import piAutoTitle from "@hheei/pi-auto-title";
import piBasics from "@hheei/pi-basics";
import piBtw from "@hheei/pi-btw";
import piCaveman from "@hheei/pi-caveman";
import piDollarSkill from "@hheei/pi-dollar-skill";
import piFix from "@hheei/pi-fix";
import piGoal from "@hheei/pi-goal";
import piLoadout from "@hheei/pi-loadout";
import piPlan from "@hheei/pi-plan";
import piPonytail from "@hheei/pi-ponytail";
import piRtk from "@hheei/pi-rtk";
import piSshfs from "@hheei/pi-sshfs";
import piT2s from "@hheei/pi-t2s";
import piTodo from "@hheei/pi-todo";

export type HePiExtension = (pi: ExtensionAPI) => void;

export const hePiExtensions: readonly HePiExtension[] = [
	piBasics,
	piLoadout,
	piAdvisor,
	piAsk,
	piAutoTitle,
	piBtw,
	piCaveman,
	piDollarSkill,
	piFix,
	piGoal,
	piPlan,
	piPonytail,
	piRtk,
	piSshfs,
	piT2s,
	piTodo,
];

export default function piHepiExtension(pi: ExtensionAPI): void {
	for (const extension of hePiExtensions) extension(pi);
}
