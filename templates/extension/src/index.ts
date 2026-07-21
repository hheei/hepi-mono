import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function registerExtension(pi: ExtensionAPI) {
	pi.registerCommand("__COMMAND_NAME__", {
		description: "Show that this HEPI extension is loaded",
		handler: async (_args, ctx) => {
			ctx.ui.notify("__EXTENSION_TITLE__ loaded", "info");
		},
	});
}
