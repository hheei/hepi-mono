import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerSettings,
	setOptionalToolBullet,
} from "@hheei/pi-ext-core";
import {
	createApplyPatchSettingsProvider,
	readApplyPatchSettings,
} from "./apply-patch/settings.js";
import { isApplyPatchToolDetails } from "./apply-patch/tool.js";
import { BG_BASH_OPTIONAL_TOOL_BULLET, BG_BASH_OPTIONAL_TOOL_KEY } from "./bg-bash-tools.js";
import { createEvalRuntimeState, registerEvalLifecycle } from "./eval/lifecycle.js";
import { readEvalSettings } from "./eval/settings.js";
import { isPythonEvalToolDetails } from "./eval/tool.js";
import { grepHasNoSearchablePaths } from "./grep.js";
import { createToolsRuntimeState, registerToolsLifecycle } from "./session-state.js";
import { createTodoFeature } from "./todo/todo.js";
import { registerTools } from "./tools.js";

/** Registers pi-ext-tools' static tool catalog. */
export default function piExtToolsExtension(pi: ExtensionAPI): void {
	const state = createToolsRuntimeState();
	const evalState = createEvalRuntimeState();
	const todo = createTodoFeature(pi);
	const evalSettings = readEvalSettings();
	const _applyPatchSettings = readApplyPatchSettings();
	registerTools(pi, state, evalState);

	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-tools/settings",
		start(context): void {
			context.resources.add(
				"apply-patch-settings",
				registerSettings(createApplyPatchSettingsProvider(), getRuntimeSettingsRegistry(pi)),
			);
		},
	});
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-tools/todo",
		start: async ({ extension, resources, signal }) => {
			if (!pi.getActiveTools().includes("todo")) return;
			await todo.start(extension, signal);
			const sessionId = extension.sessionManager.getSessionId();
			resources.add("todo", () => todo.dispose(sessionId));
		},
	});
	registerEvalLifecycle(pi, evalState, evalSettings.pythonBin);
	pi.on("before_agent_start", (event) => {
		setOptionalToolBullet(
			event.systemPromptOptions.sections,
			BG_BASH_OPTIONAL_TOOL_KEY,
			BG_BASH_OPTIONAL_TOOL_BULLET,
		);
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
		return;
	});
	registerToolsLifecycle(pi, state);
}
