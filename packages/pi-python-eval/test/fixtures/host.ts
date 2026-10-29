import type { AgentToolResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

/** One nested call the bridge asked the Pi host to run. */
export interface HostToolCall {
	readonly name: string;
	readonly args: unknown;
	readonly signal: AbortSignal | undefined;
}

/** What the Pi host reports for one nested call. */
export type HostToolOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;

/** The outcome one name produces, given the call the bridge made. */
export type HostToolBehavior = (call: HostToolCall) => Promise<HostToolOutcome>;

/**
 * A Pi host double that serves nested tool calls the way the host does: through
 * `executeTool()`, reporting the failure state of the call instead of throwing for a tool failure.
 * Tests state which outcome each name produces, so no production tool registry is ever exercised.
 */
function hostOutcome(
	name: string,
	text: string,
	options: {
		readonly details?: unknown;
		readonly isError?: boolean;
	} = {},
): HostToolOutcome {
	const result: AgentToolResult<unknown> = {
		content: [{ type: "text", text }],
		details: options.details ?? { text },
	};
	return {
		toolCall: { type: "toolCall", id: `host-${name}-1`, name, arguments: {} },
		result,
		isError: options.isError ?? false,
	};
}

/** Answers every call with text content. */
export function hostText(text: string): HostToolBehavior {
	return async (call) => hostOutcome(call.name, text);
}

/** Answers every call with a host-declared failure. */
export function hostError(text: string): HostToolBehavior {
	return async (call) => hostOutcome(call.name, text, { isError: true });
}

/** Rejects the call, as the host does for a blocked or dispatched-away call. */
export function hostRejection(message: string): HostToolBehavior {
	return async () => {
		throw new Error(message);
	};
}

/**
 * The context handed to the eval tool, plus the calls the host saw. `tools` is the list
 * `executeTool` resolves against; a test that models an unregistered name leaves it out.
 */
export function nativeHost(
	behavior: HostToolBehavior,
	options: { readonly tools?: readonly string[] } = {},
): {
	readonly context: ExtensionToolContext;
	readonly calls: HostToolCall[];
} {
	const calls: HostToolCall[] = [];
	const tools = (
		options.tools ?? ["read", "bash", "grep", "find", "edit", "write", "apply_patch"]
	).map((name) => ({ name }));
	return {
		context: {
			tools,
			executeTool: async (name: string, args: unknown, options?: { signal?: AbortSignal }) => {
				const call = { name, args, signal: options?.signal };
				calls.push(call);
				return await behavior(call);
			},
		} as unknown as ExtensionToolContext,
		calls,
	};
}
