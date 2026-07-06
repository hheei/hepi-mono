import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatExtensionLabel } from "@hheei/pi-extcore";

const extensionName = "__EXTENSION_TITLE__";

export default function registerExtension(pi: ExtensionAPI) {
	pi.registerCommand("__COMMAND_NAME__", {
		description: "Show that this HEPI extension is loaded",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`${formatExtensionLabel(extensionName)} loaded`, "info");
		},
	});
}
