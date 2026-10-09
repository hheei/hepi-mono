import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type ExtensionLifecycleContext,
	getRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerSettings,
} from "@hheei/pi-ext-core";
import {
	createApplyPatchSettingsProvider,
	readApplyPatchSettings,
} from "./apply-patch/settings.js";
import { registerApplyPatchGuard } from "./apply-patch-guard.js";
import { isApplyPatchToolDetails } from "./apply-patch-tool.js";
import { createEvalRuntimeState, registerEvalLifecycle } from "./eval/lifecycle.js";
import { readEvalSettings } from "./eval/settings.js";
import { isPythonEvalToolDetails } from "./eval/tool.js";
import { createFffRuntimeState, registerFffLifecycle } from "./fff/lifecycle.js";
import { registerCommands } from "./fff/register-commands.js";
import { grepHasNoSearchablePaths } from "./grep.js";
import { remoteMutationDetails } from "./native-remote.js";
import { applyTargetPromptSection } from "./targets.js";
import { createTodoSettingsProvider, readTodoSettings } from "./todo/settings.js";
import { createTodoFeature } from "./todo/todo.js";
import {
	activateApplyPatchTool,
	activatePythonEvalCatalog,
	activateTodoCatalog,
	registerTools,
} from "./tools.js";

/** Registers pi-ext-tools' static tool catalog. */
export default function piExtToolsExtension(pi: ExtensionAPI): void {
	const state = createFffRuntimeState();
	const evalState = createEvalRuntimeState();
	const todo = createTodoFeature(pi);
	const evalSettings = readEvalSettings();
	const evalEnabled = evalSettings.enabled;
	const todoSettings = readTodoSettings();
	const todoEnabled = todoSettings.enabled;
	const applyPatchSettings = readApplyPatchSettings();
	const applyPatchEnabled = applyPatchSettings.enabled;
	let session: ExtensionLifecycleContext | undefined;
	registerTools(pi, state, evalState);

	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-tools/settings",
		start(context): void {
			context.resources.add(
				"apply-patch-settings",
				registerSettings(createApplyPatchSettingsProvider(), getRuntimeSettingsRegistry(pi)),
			);
			context.resources.add(
				"todo-settings",
				registerSettings(createTodoSettingsProvider(), getRuntimeSettingsRegistry(pi)),
			);
			session = context;
			activateApplyPatchTool(context, applyPatchEnabled);
			activatePythonEvalCatalog(context, evalEnabled);
			activateTodoCatalog(context, todoEnabled);
			context.resources.add("settings-state", () => {
				if (session === context) session = undefined;
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
		applyTargetPromptSection(event.systemPromptOptions.sections, state.getTargetRuntime());
	});
	pi.on("tool_result", (event) => {
		if (
			event.toolName === "python_eval" &&
			isPythonEvalToolDetails(event.details) &&
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
