import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerSettings,
} from "@hheei/pi-ext-core";
import { createApplyPatchSettingsProvider } from "./apply-patch/settings.js";
import { isApplyPatchToolDetails, registerApplyPatchTool } from "./apply-patch/tool.js";

export default function piApplyPatchExtension(pi: ExtensionAPI): void {
	registerApplyPatchTool(pi);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-apply-patch/settings",
		start({ resources }): void {
			resources.add(
				"settings",
				registerSettings(createApplyPatchSettingsProvider(), getRuntimeSettingsRegistry(pi)),
			);
		},
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== "apply_patch" || !isApplyPatchToolDetails(event.details)) return;
		const details = event.details;
		if (
			details.status === "failed" ||
			(details.unconfirmed?.length ?? 0) > 0 ||
			(details.notApplied?.length ?? 0) > 0
		)
			return { isError: true };
		return;
	});
}
