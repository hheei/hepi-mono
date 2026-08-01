import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { createSubagentsFeature } from "./feature.js";

export default function piSubagentsExtension(pi: ExtensionAPI): void {
	const feature = createSubagentsFeature(pi);
	registerExtensionLifecycle(pi, { key: "@hheei/pi-subagents", start: feature.start });
	pi.registerTool(
		defineTool({
			name: "agent",
			label: "Run agent task",
			description:
				"Launch a bounded child-agent task and receive its terminal result in a follow-up turn.",
			parameters: Type.Object({
				task: Type.String({ minLength: 1, pattern: ".*\\S.*" }),
				prompt: Type.String({ minLength: 1, pattern: ".*\\S.*" }),
				agent: Type.String({ minLength: 1, pattern: ".*\\S.*" }),
				maxTurns: Type.Integer({ minimum: 1, maximum: 50 }),
			}),
			async execute(_toolCallId, args, signal, _onUpdate, context) {
				return feature.launch(args, signal, context);
			},
		}),
	);
}
