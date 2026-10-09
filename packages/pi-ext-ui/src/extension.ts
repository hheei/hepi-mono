import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCollapsibleToolRenderer } from "./renderer.js";

export default function (pi: ExtensionAPI): void {
	registerCollapsibleToolRenderer(pi);
}
