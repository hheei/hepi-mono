import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolActivationCoordinator } from "../../../hepi-basics/src/core/index.js";
import {
	ASK_PARAMETERS,
	ASK_PROMPT_GUIDELINES,
	ASK_PROMPT_SNIPPET,
	ASK_TOOL_DESCRIPTION,
	ASK_TOOL_LABEL,
	ASK_TOOL_NAME,
	createAskFeature,
} from "../../src/pi-ask/feature.js";

interface RegisteredTool {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly promptSnippet?: string;
	readonly promptGuidelines?: readonly string[];
	readonly parameters: unknown;
	readonly executionMode?: string;
}

describe("Ask registration", () => {
	test("exposes approved model-facing contract", () => {
		let registered: RegisteredTool | undefined;
		const pi = {
			registerTool(tool: unknown) {
				registered = tool as RegisteredTool;
			},
		} as unknown as ExtensionAPI;
		const coordinator = {
			setAskVisible() {},
		} as unknown as ToolActivationCoordinator;

		createAskFeature(pi, coordinator);
		const tool = registered!;

		expect(tool.name).toBe(ASK_TOOL_NAME);
		expect(tool.label).toBe(ASK_TOOL_LABEL);
		expect(tool.description).toBe(ASK_TOOL_DESCRIPTION);
		expect(tool.promptSnippet).toBe(ASK_PROMPT_SNIPPET);
		expect(tool.promptGuidelines).toEqual([...ASK_PROMPT_GUIDELINES]);
		expect(tool.executionMode).toBe("sequential");
		expect(tool.parameters).toBe(ASK_PARAMETERS);
	});
});
