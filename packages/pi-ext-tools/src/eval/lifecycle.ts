import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerSettings,
} from "@hheei/pi-ext-core";
import { clearEvalNestedLive } from "./bridge.js";
import { EvalKernelHost } from "./kernel/host.js";
import type { EvalLanguage } from "./kernel/protocol.js";
import type { EvalRuntimeHooks } from "./runtime.js";
import { createEvalSettingsProvider } from "./settings.js";

export interface EvalExecutor {
	runWithHooks(
		code: string,
		hooks: EvalRuntimeHooks,
		signal?: AbortSignal,
		language?: EvalLanguage,
		reset?: boolean,
	): Promise<unknown>;
	dispose(): void;
}

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
		clearEvalNestedLive();
		mutable.runtime = undefined;
	};
}

export function registerEvalLifecycle(
	pi: ExtensionAPI,
	state: EvalRuntimeState,
	enabled: boolean,
	pythonBin?: string,
): void {
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-tools/eval",
		start(context): void {
			context.resources.add(
				"eval-settings",
				registerSettings(createEvalSettingsProvider(), getRuntimeSettingsRegistry(pi)),
			);
			if (!enabled) return;
			context.resources.add(
				"eval-runtime",
				startEvalRuntime(
					state,
					new EvalKernelHost(context.extension.cwd, pythonBin === undefined ? {} : { pythonBin }),
				),
			);
		},
	});
}
