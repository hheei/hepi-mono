import type { Api, Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedChildSessionFactory } from "@hheei/pi-ext-core";

/** BTW's complete child tool boundary: repository inspection only. */
export const BTW_CHILD_BUILTIN_TOOLS = ["read", "grep", "find", "ls"] as const;

export function createBtwChildFactory(
	context: ExtensionContext,
	options: { readonly model: Model<Api>; readonly systemPrompt: string },
): ResolvedChildSessionFactory {
	return {
		async create(signal: AbortSignal) {
			signal.throwIfAborted();
			const cwd = context.cwd;
			const agentDir = getAgentDir();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPromptOverride: () => options.systemPrompt,
			});
			await resourceLoader.reload();
			signal.throwIfAborted();
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				sessionManager: SessionManager.inMemory(cwd),
				resourceLoader,
				tools: [...BTW_CHILD_BUILTIN_TOOLS],
				model: options.model,
				thinkingLevel: "off",
			});
			return session;
		},
	};
}
