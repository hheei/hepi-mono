import type { Api, Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedChildSessionFactory } from "@hheei/pi-ext-core";

/** Built-in exploration tools exposed to a read-only MCTX child (no bash/write/edit). */
export const MCTX_CHILD_BUILTIN_TOOLS = ["read", "grep", "find", "ls"] as const;

/** Soft turn cap for one read-only MCTX child task; core adds wrap-up and grace turns. */
export const MCTX_CHILD_MAX_TURNS = 3;

/** Wall-clock deadline for one MCTX child task (its maxTurns cannot bound a hung tool call). */
export const MCTX_CHILD_TASK_TIMEOUT_MS = 60_000;

/**
 * Consumer-owned read-only child-session policy for Dreamer commands. The
 * child runs with no extensions and exactly four built-in exploration tools.
 */
export function createMctxChildFactory(
	context: ExtensionContext,
	options: {
		readonly model: Model<Api> | undefined;
		readonly systemPrompt: string;
	},
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
				tools: [...MCTX_CHILD_BUILTIN_TOOLS],
				...(options.model === undefined ? {} : { model: options.model }),
				thinkingLevel: "off",
			});
			return session;
		},
	};
}
