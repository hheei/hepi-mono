import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantSelectionAddon } from "./assistant-selection.js";

/** Registers Pi-host integrations owned by pi-ext-addon. */
export default function piExtAddonExtension(pi: ExtensionAPI): void {
	pi.registerAssistantMessageAddon(createAssistantSelectionAddon());
}
