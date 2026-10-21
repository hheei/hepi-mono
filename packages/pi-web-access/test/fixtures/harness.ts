import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

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
			registerShortcut: (): void => undefined,
			appendEntry: (): void => undefined,
			sendMessage: (): void => undefined,
			exec: async (): Promise<{ stdout: string; stderr: string; code: number }> => ({
				stdout: "",
				stderr: "",
				code: 0,
			}),
			getAllTools: (): readonly ToolDefinition[] => tools,
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

export function toolFor(tools: readonly ToolDefinition[], name: string): ToolDefinition {
	const tool = tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`${name} was not registered`);
	return tool;
}
