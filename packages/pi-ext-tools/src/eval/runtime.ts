export interface EvalRuntimeHooks {
	readonly cwd: string;
	onText(text: string): void;
	onDisplay(value: unknown): void;
	callTool(name: string, args: unknown): Promise<unknown>;
}
