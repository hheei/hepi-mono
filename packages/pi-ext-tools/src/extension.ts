import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type ExtensionLifecycleContext,
	getRuntimeSettingsRegistry,
	getToolTui,
	registerExtensionLifecycle,
	registerSettings,
	registerToolTuiTrace,
} from "@hheei/pi-ext-core";
import { APPLY_PATCH_SETTINGS_KEY } from "./apply-patch/policy.js";
import { registerApplyPatchGuard } from "./apply-patch-guard.js";
import { isApplyPatchToolDetails } from "./apply-patch-tool.js";
import { createEvalRuntimeState, registerEvalLifecycle } from "./eval/lifecycle.js";
import { readEvalSettings } from "./eval/settings.js";
import { isEvalToolDetails } from "./eval/tool.js";
import { createFffRuntimeState, registerFffLifecycle } from "./fff/lifecycle.js";
import { registerCommands } from "./fff/register-commands.js";
import { type EditCatalog, readEditMode, resolveEditCatalog } from "./fff/settings.js";
import { grepHasNoSearchablePaths } from "./grep.js";
import { remoteMutationDetails } from "./native-remote.js";
import { applyTargetPromptSection } from "./targets.js";
import { createTodoSettingsProvider, readTodoSettings } from "./todo/settings.js";
import { createTodoFeature } from "./todo/todo.js";
import { registerToolTuiLifecycle } from "./tool-tui-settings.js";
import {
	activateEditCatalog,
	activateEvalCatalog,
	activateTodoCatalog,
	registerTools,
} from "./tools.js";

/** Registers pi-ext-tools' static, canonical tool catalog. */
export default function piExtToolsExtension(pi: ExtensionAPI): void {
	const state = createFffRuntimeState();
	const evalState = createEvalRuntimeState();
	const tui = getToolTui(pi);
	registerToolTuiTrace(pi);
	registerToolTuiLifecycle(pi, tui);
	const todo = createTodoFeature(pi);
	const evalSettings = readEvalSettings();
	const evalEnabled = evalSettings.enabled;
	const todoSettings = readTodoSettings();
	const todoEnabled = todoSettings.enabled;
	let editCatalog: EditCatalog | undefined;
	let session: ExtensionLifecycleContext | undefined;
	const evalTool = registerTools(pi, state, tui, evalState);
	const syncEditCatalog = (context: ExtensionLifecycleContext, model: unknown): void => {
		const resolved = resolveEditCatalog(
			readEditMode(),
			model as Parameters<typeof resolveEditCatalog>[1],
		);
		if (session === context && editCatalog === resolved) return;
		editCatalog = resolved;
		activateEditCatalog(context, resolved, evalTool);
	};
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-tools/edit-catalog",
		start(context): void {
			context.resources.add(
				"apply-patch-settings-group",
				getRuntimeSettingsRegistry(pi).registerGroups("@hheei/pi-ext-tools/apply-patch", [
					APPLY_PATCH_SETTINGS_KEY,
				]),
			);
			context.resources.add(
				"todo-settings",
				registerSettings(createTodoSettingsProvider(), getRuntimeSettingsRegistry(pi)),
			);
			session = context;
			syncEditCatalog(context, context.extension.model);
			activateEvalCatalog(context, evalEnabled);
			activateTodoCatalog(context, todoEnabled);
			context.resources.add("edit-catalog-state", () => {
				if (session === context) session = undefined;
				editCatalog = undefined;
			});
		},
	});
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-tools/todo",
		start: async ({ extension, resources, signal }) => {
			if (!todoEnabled) return;
			await todo.start(extension, signal);
			const sessionId = extension.sessionManager.getSessionId();
			resources.add("todo", () => todo.dispose(sessionId));
		},
	});
	registerEvalLifecycle(pi, evalState, evalEnabled, evalSettings.pythonBin);
	pi.on("before_agent_start", (event) => {
		if (session !== undefined) syncEditCatalog(session, session.extension.model);
		applyTargetPromptSection(event.systemPromptOptions.sections, state.getTargetRuntime());
	});
	pi.on("model_select", (event) => {
		if (session === undefined) return;
		syncEditCatalog(session, event.model);
	});
	pi.on("tool_result", (event) => {
		if (
			event.toolName === "eval" &&
			isEvalToolDetails(event.details) &&
			event.details.error !== undefined
		)
			return { isError: true };
		if (event.toolName === "grep" && grepHasNoSearchablePaths(event.details))
			return { isError: true };
		if (event.toolName === "apply_patch" && isApplyPatchToolDetails(event.details)) {
			const details = event.details;
			if (
				details.status === "failed" ||
				(details.unconfirmed?.length ?? 0) > 0 ||
				(details.notApplied?.length ?? 0) > 0
			)
				return { isError: true };
		}
		const mutation =
			event.toolName === "edit" || event.toolName === "write"
				? remoteMutationDetails(event.details)
				: undefined;
		if (
			mutation !== undefined &&
			mutation.outcome !== "changed" &&
			mutation.outcome !== "no_change"
		)
			return { isError: true };
		return;
	});
	registerApplyPatchGuard(pi);
	registerCommands(pi, { getRuntime: () => state.getRuntime() ?? null });
	registerFffLifecycle(pi, state);
}
