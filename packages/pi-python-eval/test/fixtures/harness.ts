import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

/** A pi double that captures the tools an extension registers. */
export function toolHost(activeTools: readonly string[] = ["read", "bash", "edit", "write"]): {
	readonly pi: ExtensionAPI;
	readonly tools: ToolDefinition[];
	readonly activeTools: () => readonly string[];
	readonly emit: (event: string, ...args: unknown[]) => void;
} {
	const tools: ToolDefinition[] = [];
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	let active = [...activeTools];
	return {
		pi: {
			events: {},
			on: (event: string, handler: (...args: unknown[]) => void): (() => void) => {
				const group = listeners.get(event) ?? new Set();
				group.add(handler);
				listeners.set(event, group);
				return (): void => {
					group.delete(handler);
				};
			},
			registerTool: (tool: ToolDefinition): void => {
				tools.push(tool);
			},
			registerCommand: (): void => undefined,
			getActiveTools: (): readonly string[] => active,
			setActiveTools: (names: string[]): void => {
				active = names;
			},
		} as unknown as ExtensionAPI,
		tools,
		activeTools: () => active,
		emit: (event: string, ...args: unknown[]): void => {
			for (const handler of listeners.get(event) ?? []) handler(...args);
		},
	};
}

/** The tool registered under this name; a missing tool fails the test instead of the assertion. */
export function toolFor(tools: readonly ToolDefinition[], name: string): ToolDefinition {
	const tool = tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`${name} was not registered`);
	return tool;
}

/** The same host double. */
export function framedHost(activeTools?: readonly string[]): ReturnType<typeof toolHost> {
	return toolHost(activeTools);
}
