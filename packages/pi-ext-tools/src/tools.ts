import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createToolTui,
	type ExtensionLifecycleContext,
	setManagedLoadoutToolsActive,
	type ToolTui,
} from "@hheei/pi-ext-core";
import {
	APPLY_PATCH_TOOL_REGISTRATION,
	isApplyPatchToolDetails,
	registerApplyPatchTool,
} from "./apply-patch-tool.js";
import { registerBashTool } from "./bash.js";
import { registerBashJobTool } from "./bash-job-tool.js";
import { EDIT_TOOL_REGISTRATION, registerEditTool } from "./edit.js";
import { type EvalNestedToolName, EvalToolBridge } from "./eval/bridge.js";
import { createEvalRuntimeState, type EvalRuntimeState } from "./eval/lifecycle.js";
import {
	applyEvalPromptGuidelines,
	EVAL_TOOL_REGISTRATION,
	registerEvalTool,
} from "./eval/tool.js";
import { createFffRuntimeState, type FffRuntimeState } from "./fff/lifecycle.js";
import type { EditCatalog } from "./fff/settings.js";
import { registerFindTool } from "./find.js";
import { registerGrepTool } from "./grep.js";
import { remoteMutationDetails } from "./native-remote.js";
import { registerReadTool } from "./read.js";
import { registerWriteTool, WRITE_TOOL_REGISTRATION } from "./write.js";

const NATIVE_EDIT_REGISTRATIONS = [EDIT_TOOL_REGISTRATION, WRITE_TOOL_REGISTRATION] as const;
const APPLY_PATCH_REGISTRATIONS = [APPLY_PATCH_TOOL_REGISTRATION] as const;
const EVAL_REGISTRATIONS = [EVAL_TOOL_REGISTRATION] as const;

/** Activates and publishes only the resolved execution catalog. */
export function activateEditCatalog(
	context: ExtensionLifecycleContext,
	catalog: EditCatalog,
	evalTool?: ReturnType<typeof registerEvalTool>,
): void {
	if (evalTool !== undefined) {
		applyEvalPromptGuidelines(evalTool, catalog);
		context.pi.registerTool(evalTool);
	}
	setManagedLoadoutToolsActive(context, NATIVE_EDIT_REGISTRATIONS, catalog === "native");
	setManagedLoadoutToolsActive(context, APPLY_PATCH_REGISTRATIONS, catalog === "apply_patch");
}

export function activateEvalCatalog(context: ExtensionLifecycleContext, enabled: boolean): void {
	setManagedLoadoutToolsActive(context, EVAL_REGISTRATIONS, enabled);
}

/** Statically registers the explicitly approved canonical tool catalog. */
export function registerTools(
	pi: ExtensionAPI,
	state: FffRuntimeState = createFffRuntimeState(),
	tui: ToolTui = createToolTui(),
	evalState: EvalRuntimeState = createEvalRuntimeState(),
): ReturnType<typeof registerEvalTool> {
	const nested = new Map<EvalNestedToolName, ToolDefinition>();
	nested.set("read", registerReadTool(pi, state, tui));
	nested.set("grep", registerGrepTool(pi, state, tui));
	nested.set("find", registerFindTool(pi, state, tui));
	nested.set("edit", registerEditTool(pi, tui, state));
	nested.set("write", registerWriteTool(pi, tui, state));
	nested.set("bash", registerBashTool(pi, state, tui));
	registerBashJobTool(pi, state, tui);
	nested.set("apply_patch", registerApplyPatchTool(pi, tui, state));
	return registerEvalTool(
		pi,
		evalState,
		new EvalToolBridge(
			nested,
			(name) => pi.getActiveTools().includes(name),
			(name, result) => nestedResultIsError(name, result),
		),
		tui,
		(text) => {
			const output = state.getTargetRuntime()?.createOutput(text);
			if (output === undefined) return undefined;
			return {
				id: output.id,
				persisted:
					"persistent" in output &&
					(output as { readonly persistent?: unknown }).persistent === true,
			};
		},
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
	if (name === "edit" || name === "write") {
		const mutation = remoteMutationDetails(details);
		return (
			mutation !== undefined && mutation.outcome !== "changed" && mutation.outcome !== "no_change"
		);
	}
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
