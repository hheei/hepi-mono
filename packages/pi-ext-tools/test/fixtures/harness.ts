import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

/** A pi double that captures the tools an extension registers. */
export function toolHost(activeTools: readonly string[] = ["read", "bash", "edit", "write"]): {
	readonly pi: ExtensionAPI;
	readonly tools: ToolDefinition[];
	readonly activeTools: () => readonly string[];
} {
	const tools: ToolDefinition[] = [];
	let active = [...activeTools];
	return {
		pi: {
			events: {},
			on: (): (() => void) => () => undefined,
			registerTool: (tool: ToolDefinition): void => {
				tools.push(tool);
			},
			getActiveTools: (): readonly string[] => active,
			setActiveTools: (names: string[]): void => {
				active = names;
			},
		} as unknown as ExtensionAPI,
		tools,
		activeTools: () => active,
	};
}

/** The tool registered under this name; a missing tool fails the test instead of the assertion. */
export function toolFor(tools: readonly ToolDefinition[], name: string): ToolDefinition {
	const tool = tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`${name} was not registered`);
	return tool;
}
