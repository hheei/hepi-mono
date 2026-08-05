import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHandoffCommand } from "./handoff.js";

export default function piHandoffExtension(pi: ExtensionAPI): void {
	registerHandoffCommand(pi);
}
