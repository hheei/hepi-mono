import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerSettings,
} from "@hheei/pi-ext-core";
import { createEvalExecutionFacts } from "./facts.js";
import { EvalKernelHost } from "./kernel/host.js";
import type { EvalRunResult, EvalRuntimeHooks } from "./runtime.js";
import { createEvalSettingsProvider } from "./settings.js";

export interface EvalExecutor {
	runWithHooks(
		code: string,
		hooks: EvalRuntimeHooks,
		signal?: AbortSignal,
		reset?: boolean,
	): Promise<EvalRunResult>;
	dispose(): void;
}

/**
 * The session's current runtime, as the statically registered tool reads it. Any object with this
 * shape is a valid reader: nothing about reading a runtime depends on who made the reader.
 */
export interface EvalRuntimeState {
	getRuntime(): EvalExecutor | undefined;
}

/**
 * One session's runtime slot: the lifecycle binds a runtime, the tool reads it through `state`.
 *
 * The two halves are separate so the statically registered tool never holds the ability to start or
 * stop a runtime; binding belongs to the lifecycle that owns the session.
 */
export interface EvalRuntime {
	readonly state: EvalRuntimeState;
	/** Binds a running runtime, disposing the one it replaces; the returned handle stops it. */
	readonly start: (runtime: EvalExecutor) => () => void;
}

export function createEvalRuntime(): EvalRuntime {
	let runtime: EvalExecutor | undefined;
	return {
		state: { getRuntime: () => runtime },
		start(next): () => void {
			runtime?.dispose();
			runtime = next;
			return () => {
				if (runtime !== next) return;
				next.dispose();
				runtime = undefined;
			};
		},
	};
}

export function registerEvalLifecycle(
	pi: ExtensionAPI,
	runtime: EvalRuntime,
	pythonBin?: string,
): void {
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-python-eval",
		start(context): void {
			context.resources.add(
				"eval-settings",
				registerSettings(createEvalSettingsProvider(), getRuntimeSettingsRegistry(pi)),
			);
			if (!pi.getActiveTools().includes("python_eval")) return;
			context.resources.add(
				"eval-runtime",
				runtime.start(
					new EvalKernelHost(context.extension.cwd, {
						...(pythonBin === undefined ? {} : { pythonBin }),
						facts: createEvalExecutionFacts(context.pi, context.extension.sessionManager),
					}),
				),
			);
		},
	});
}
