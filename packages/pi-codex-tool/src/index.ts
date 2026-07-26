import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerApplyPatchTool } from "./tools/apply-patch/tool.js";

export default function applyPatchExtension(pi: ExtensionAPI): void {
	registerApplyPatchTool(pi);
}
