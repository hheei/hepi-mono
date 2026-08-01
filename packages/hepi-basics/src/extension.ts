import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piBasics from "./core/index.js";
import piDollarSkill from "./dollar-skill/index.js";
import piFix from "./fix/index.js";
import piRetry from "./retry/index.js";
import piRtk from "./rtk/index.js";
import piT2s from "./t2s/index.js";

export type HepiExtension = (pi: ExtensionAPI) => void;

export const hepiBasicsExtensions: readonly HepiExtension[] = [
	piBasics,
	piRetry,
	piRtk,
	piDollarSkill,
	piFix,
	piT2s,
];

export default function piHepiBasicsExtension(pi: ExtensionAPI): void {
	for (const extension of hepiBasicsExtensions) extension(pi);
}
