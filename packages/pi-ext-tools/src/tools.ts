import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isApplyPatchToolDetails, registerApplyPatchTool } from "./apply-patch/tool.js";
import { registerBashTool } from "./bash.js";
import { registerTaskTools } from "./bg-bash-tools.js";
import { registerEditTool } from "./edit.js";
import { type EvalNestedToolName, EvalToolBridge } from "./eval/bridge.js";
import { createEvalRuntimeState, type EvalRuntimeState } from "./eval/lifecycle.js";
import { registerPythonEvalTool } from "./eval/tool.js";
import { registerFindTool } from "./find.js";
import { registerGrepTool } from "./grep.js";
import { registerReadTool } from "./read.js";
import { createToolsRuntimeState, type ToolsRuntimeState } from "./session-state.js";
import { registerWriteTool } from "./write.js";

/** Statically registers the tool catalog. */
export function registerTools(
	pi: ExtensionAPI,
	state: ToolsRuntimeState = createToolsRuntimeState(),
	evalState: EvalRuntimeState = createEvalRuntimeState(),
): ReturnType<typeof registerPythonEvalTool> {
	const nested = new Map<EvalNestedToolName, ToolDefinition>();
	nested.set("read", registerReadTool(pi, state));
	nested.set("grep", registerGrepTool(pi, state));
	nested.set("find", registerFindTool(pi, state));
	nested.set("edit", registerEditTool(pi, state));
	nested.set("write", registerWriteTool(pi, state));
	nested.set("bash", registerBashTool(pi, state));
	registerTaskTools(pi, state);
	nested.set("apply_patch", registerApplyPatchTool(pi, state));
	return registerPythonEvalTool(
		pi,
		evalState,
		new EvalToolBridge(
			nested,
			(name) => pi.getActiveTools().includes(name),
			(name, result) => nestedResultIsError(name, result),
		),
	);
}

function nestedResultIsError(
	name: EvalNestedToolName,
	result: { readonly details?: unknown },
): boolean {
	const details = result.details;
	if (name === "apply_patch" && isApplyPatchToolDetails(details))
		return (
			details.status === "failed" ||
			(details.unconfirmed?.length ?? 0) > 0 ||
			(details.notApplied?.length ?? 0) > 0
		);

	if (typeof details !== "object" || details === null) return false;
	const record = details as Record<string, unknown>;
	if (name === "bash")
		return (
			record.timedOut === true ||
			record.error !== undefined ||
			(typeof record.exitCode === "number" && record.exitCode !== 0)
		);
	return (
		record.outcome !== undefined &&
		record.outcome !== "ok" &&
		record.outcome !== "changed" &&
		record.outcome !== "no_change"
	);
}
