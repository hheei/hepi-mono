import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedChildSessionFactory } from "@hheei/pi-ext-core";
import type { ResolvedProfile } from "./profiles.js";

export interface ChildSessionFactoryOptions {
	readonly cwd: string;
	readonly modelRegistry: Pick<ModelRegistry, "getRegisteredProviderIds">;
	/** Current parent selection is public evidence used only to reject dynamic-provider fallback. */
	readonly parentModel?: Model<Api>;
	readonly createSession?: typeof createAgentSession;
	readonly getChildAgentDir?: () => string;
}

/**
 * Creates isolated in-memory child sessions through Pi's public SDK. Core owns
 * their disposal after task terminalization, while this factory only forwards abort.
 */
export function createChildSessionFactory(
	profile: ResolvedProfile,
	options: ChildSessionFactoryOptions,
): ResolvedChildSessionFactory {
	return {
		async create(signal: AbortSignal): Promise<AgentSession> {
			signal.throwIfAborted();
			const dynamicProviders = options.modelRegistry.getRegisteredProviderIds();
			if (
				profile.model !== undefined &&
				profile.modelSelection === "explicit" &&
				dynamicProviders.includes(profile.model.provider)
			) {
				throw new Error(
					`Profile ${profile.name} selects dynamically registered provider ${profile.model.provider}, which a public child runtime cannot use`,
				);
			}
			if (
				profile.model === undefined &&
				options.parentModel !== undefined &&
				dynamicProviders.includes(options.parentModel.provider)
			) {
				throw new Error(
					`Profile ${profile.name} relies on dynamically registered provider ${options.parentModel.provider}, which a public child runtime cannot use`,
				);
			}
			const agentDir = (options.getChildAgentDir ?? getAgentDir)();
			const resourceLoader = new DefaultResourceLoader({
				cwd: options.cwd,
				agentDir,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt: profile.systemPrompt,
			});
			await resourceLoader.reload();
			signal.throwIfAborted();
			const { session } = await (options.createSession ?? createAgentSession)({
				cwd: options.cwd,
				agentDir,
				sessionManager: SessionManager.inMemory(),
				resourceLoader,
				tools: [...profile.tools],
				...(profile.model === undefined ? {} : { model: profile.model }),
				...(profile.thinking === undefined ? {} : { thinkingLevel: profile.thinking }),
			});
			return session;
		},
	};
}
