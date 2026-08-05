import type { AgentConfig, IsolationMode, JoinMode, ThinkingLevel } from "./types.js";

interface AgentInvocationParams {
	model?: string;
	thinking?: string;
	max_turns?: number;
	run_in_background?: boolean;
	inherit_context?: boolean;
	isolated?: boolean;
	isolation?: IsolationMode;
}

export function resolveAgentInvocationConfig(
	agentConfig: AgentConfig | undefined,
	params: AgentInvocationParams,
): {
	modelInput?: string;
	modelFromParams: boolean;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	inheritContext: boolean;
	runInBackground: boolean;
	isolated: boolean;
	isolation?: IsolationMode;
} {
	return {
		...((agentConfig?.model ?? params.model) === undefined
			? {}
			: { modelInput: agentConfig?.model ?? params.model }),
		modelFromParams: agentConfig?.model == null && params.model != null,
		...((agentConfig?.thinking ?? params.thinking) === undefined
			? {}
			: { thinking: (agentConfig?.thinking ?? params.thinking) as ThinkingLevel }),
		...((agentConfig?.maxTurns ?? params.max_turns) === undefined
			? {}
			: { maxTurns: agentConfig?.maxTurns ?? params.max_turns }),
		inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
		runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
		isolated: agentConfig?.isolated ?? params.isolated ?? false,
		...((agentConfig?.isolation ?? params.isolation) === undefined
			? {}
			: { isolation: agentConfig?.isolation ?? params.isolation }),
	};
}

export function resolveJoinMode(
	defaultJoinMode: JoinMode,
	runInBackground: boolean,
): JoinMode | undefined {
	return runInBackground ? defaultJoinMode : undefined;
}
