import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EvalToolBridge } from "./bridge.js";
import { createEvalRuntimeState, registerEvalLifecycle } from "./lifecycle.js";
import { readEvalSettings } from "./settings.js";
import { registerPythonEvalTool } from "./tool.js";

/**
 * Registers python_eval.
 *
 * The kernel, its session lifecycle, and the nested-call bridge all belong to this package; every
 * nested tool call is dispatched by the Pi host, so this extension never needs the other tool
 * packages to be installed to stay loadable.
 */
export default function pythonEvalExtension(pi: ExtensionAPI): void {
	const state = createEvalRuntimeState();
	const settings = readEvalSettings();
	registerPythonEvalTool(
		pi,
		state,
		new EvalToolBridge((name) => pi.getActiveTools().includes(name)),
	);
	registerEvalLifecycle(pi, state, settings.pythonBin);
}
