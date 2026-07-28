import { type AftConfig, resolveBashConfig } from "./config.js";

export type HepiAftToolSurface = {
	readonly enabled: boolean;
	readonly bash: boolean;
	readonly read: boolean;
	readonly write: boolean;
	readonly edit: boolean;
	readonly applyPatch: boolean;
	readonly outline: boolean;
	readonly zoom: boolean;
	readonly safety: boolean;
	readonly inspect: boolean;
	readonly importTool: boolean;
	readonly callgraph: boolean;
	readonly refactor: boolean;
	readonly restrictToProjectRoot: boolean;
};

function isEnabled(disabled: ReadonlySet<string>, name: string): boolean {
	return !disabled.has(name);
}

export function resolveHepiAftToolSurface(config: AftConfig): HepiAftToolSurface {
	const disabled = new Set(config.disabled_tools ?? []);
	const enabled = config.enabled !== false;
	const minimal = (config.tool_surface ?? "recommended") === "minimal";
	const all = (config.tool_surface ?? "recommended") === "all";
	const visible = (name: string): boolean => enabled && isEnabled(disabled, name);

	return {
		enabled,
		bash: visible("bash") && resolveBashConfig(config).enabled,
		read: !minimal && visible("read"),
		write: !minimal && visible("write"),
		edit: !minimal && visible("edit"),
		applyPatch: !minimal && visible("apply_patch"),
		outline: visible("aft_outline"),
		zoom: visible("aft_zoom"),
		safety: visible("aft_safety") && config.backup?.enabled !== false,
		inspect: !minimal && visible("aft_inspect") && config.inspect?.enabled !== false,
		importTool: !minimal && visible("aft_import"),
		callgraph: all && visible("aft_callgraph"),
		refactor: all && visible("aft_refactor"),
		restrictToProjectRoot: config.restrict_to_project_root ?? false,
	};
}
