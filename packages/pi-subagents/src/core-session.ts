import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedChildSessionFactory } from "@hheei/pi-ext-core";
import { BUILTIN_TOOL_NAMES, getAgentConfig } from "./agent-types.js";
import { detectEnv } from "./env.js";
import { buildAgentPrompt } from "./prompts.js";
import type { AgentConfig, SubagentType, ThinkingLevel } from "./types.js";

export interface CoreSessionOptions {
	readonly pi: ExtensionAPI;
	readonly agentId?: string;
	readonly model?: Model<Api>;
	readonly thinkingLevel?: ThinkingLevel;
	readonly cwd?: string;
	readonly configCwd?: string;
	readonly isolated?: boolean;
	readonly inheritContext?: boolean;
}

function fallbackConfig(type: SubagentType): AgentConfig {
	return {
		name: type,
		description: "General-purpose subagent",
		builtinToolNames: [...BUILTIN_TOOL_NAMES],
		extensions: false,
		skills: false,
		systemPrompt: "",
		promptMode: "append",
	};
}

/**
 * Resolves one consumer-owned child-session factory. The returned session is
 * still created and disposed by pi-ext-core; this module only supplies policy
 * and Pi's public session constructor.
 */
export function createCoreSessionFactory(
	context: ExtensionContext,
	type: SubagentType,
	options: CoreSessionOptions,
): ResolvedChildSessionFactory {
	return {
		async create(signal: AbortSignal) {
			signal.throwIfAborted();
			const cwd = options.cwd ?? context.cwd;
			const configCwd = options.configCwd ?? cwd;
			const config = getAgentConfig(type) ?? fallbackConfig(type);
			const environment = await detectEnv(options.pi, cwd);
			const systemPrompt = buildAgentPrompt(config, cwd, environment, context.getSystemPrompt());
			const agentDir = getAgentDir();
			const resourceLoader = new DefaultResourceLoader({
				cwd: configCwd,
				agentDir,
				noExtensions: options.isolated === true || config.extensions === false,
				noSkills: config.skills === false,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPromptOverride: () => systemPrompt,
			});
			await resourceLoader.reload();
			signal.throwIfAborted();
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				sessionManager: SessionManager.inMemory(cwd),
				resourceLoader,
				tools: [...(config.builtinToolNames ?? BUILTIN_TOOL_NAMES)],
				...(options.model === undefined ? {} : { model: options.model }),
				...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
			});
			if (!options.isolated && config.extensions !== false) {
				await session.bindExtensions({ onError: () => undefined });
			}
			signal.throwIfAborted();
			if (options.agentId !== undefined)
				session.setSessionName(`${config.name}#${options.agentId.slice(0, 8)}`);
			return session;
		},
	};
}
