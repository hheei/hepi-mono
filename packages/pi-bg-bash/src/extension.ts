import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setOptionalToolBullet } from "@hheei/pi-ext-core";
import {
	BG_BASH_OPTIONAL_TOOL_BULLET,
	BG_BASH_OPTIONAL_TOOL_KEY,
	registerBgBashTools,
} from "./bg-bash-tools.js";
import { createBashRuntimeState, registerBashLifecycle } from "./session-state.js";

/** Registers background Bash tools over one session-owned job registry. */
export default function piBgBashExtension(pi: ExtensionAPI): void {
	const state = createBashRuntimeState();
	registerBgBashTools(pi, state);
	pi.on("before_agent_start", (event) => {
		setOptionalToolBullet(
			event.systemPromptOptions.sections,
			BG_BASH_OPTIONAL_TOOL_KEY,
			BG_BASH_OPTIONAL_TOOL_BULLET,
		);
	});
	registerBashLifecycle(pi, state);
}
