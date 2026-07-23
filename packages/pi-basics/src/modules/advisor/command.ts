import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AdvisorFeature } from "./feature.js";
export function registerAdvisorCommand(pi: ExtensionAPI, feature: AdvisorFeature): void {
	pi.registerCommand("advisor", {
		description: "Enable, disable, or inspect Advisor",
		getArgumentCompletions: (prefix) =>
			["on", "off", "status"]
				.filter((item) => item.startsWith(prefix.trim()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			await feature.command(args.trim(), ctx);
		},
	});
}
