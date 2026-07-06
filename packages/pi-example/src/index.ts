import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	formatExtensionLabel,
	registerExtensionSettings,
	type SettingGroup,
} from "@hheei/pi-extcore";
import { Type } from "typebox";

const extensionName = "Example";

const settingGroups: SettingGroup[] = [
	{
		id: "example",
		title: "Example",
		description: "Example extension settings",
		fields: [
			{
				id: "enabled",
				label: "Enabled",
				defaultValue: true,
				description: "Enable example behavior",
			},
			{
				id: "mode",
				label: "Mode",
				defaultValue: "balanced",
				options: [
					{ value: "fast", label: "Fast" },
					{ value: "balanced", label: "Balanced" },
					{ value: "strict", label: "Strict" },
				],
			},
		],
	},
];

export default function piExample(pi: ExtensionAPI) {
	pi.registerCommand("pi-example", {
		description: "Show that the HEPI example extension is loaded",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`${formatExtensionLabel(extensionName)} loaded`, "info");
		},
	});

	registerExtensionSettings(pi, {
		id: "pi-example",
		title: "PI Example",
		description: "Example extension",
		groups: settingGroups,
	});

	pi.registerTool({
		name: "pi_example_echo",
		label: "PI Example Echo",
		description: "Echo text through the HEPI example extension",
		parameters: Type.Object({
			text: Type.String({ description: "Text to echo" }),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: params.text }],
				details: {
					extension: "pi-example",
				},
			};
		},
	});
}
