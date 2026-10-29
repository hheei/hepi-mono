export { BashJobRegistry } from "./bash-jobs.js";
export { BashExecutionLedger, bashExecutionDirectory } from "./bash-ledger.js";
export type { BashSettings } from "./bash-settings.js";
export { DEFAULT_BASH_SETTINGS, readBashSettings } from "./bash-settings.js";
export {
	BG_BASH_OPTIONAL_TOOL_BULLET,
	BG_BASH_OPTIONAL_TOOL_KEY,
	registerBgBashTools,
} from "./bg-bash-tools.js";
export { default } from "./extension.js";
export {
	type BackgroundBashRuntimeState,
	type BashRuntime,
	type BashRuntimeSlot,
	createBashRuntime,
	registerBashLifecycle,
} from "./session-state.js";
