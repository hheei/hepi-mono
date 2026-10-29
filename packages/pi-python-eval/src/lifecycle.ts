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
 * The session's current runtime, as the statically registered tool reads it.
 *
 * The mutable half lives in a module-level WeakMap keyed by this object, so a structurally identical
 * object is not an equivalent: its getter never sees a runtime, and `startEvalRuntime()` rejects it.
 * Only `createEvalRuntimeState()` produces a usable one.
 */
export interface EvalRuntimeState {
	getRuntime(): EvalExecutor | undefined;
}

type MutableEvalRuntimeState = { runtime: EvalExecutor | undefined };

const states = new WeakMap<EvalRuntimeState, MutableEvalRuntimeState>();

export function createEvalRuntimeState(): EvalRuntimeState {
	const state: EvalRuntimeState = { getRuntime: () => states.get(state)?.runtime };
	states.set(state, { runtime: undefined });
	return state;
}

export function startEvalRuntime(state: EvalRuntimeState, runtime: EvalExecutor): () => void {
	const mutable = states.get(state);
	if (mutable === undefined)
		throw new Error("Eval runtime state must be created by createEvalRuntimeState().");
	mutable.runtime?.dispose();
	mutable.runtime = runtime;
	return () => {
		if (mutable.runtime !== runtime) return;
		runtime.dispose();
		mutable.runtime = undefined;
	};
}

export function registerEvalLifecycle(
	pi: ExtensionAPI,
	state: EvalRuntimeState,
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
				startEvalRuntime(
					state,
					new EvalKernelHost(context.extension.cwd, {
						...(pythonBin === undefined ? {} : { pythonBin }),
						facts: createEvalExecutionFacts(context.pi, context.extension.sessionManager),
					}),
				),
			);
		},
	});
}
