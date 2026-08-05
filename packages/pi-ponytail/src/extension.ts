import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piPonytail from "./ponytail/index.js";

export default function piPonytailExtension(pi: ExtensionAPI): void {
	piPonytail(pi);
}
