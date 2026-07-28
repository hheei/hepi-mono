import { resolveCortexKitStorageRoot } from "@cortexkit/aft-bridge";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HepiLifecycleController,
	type HepiLoadoutGroup,
	registerHepiLifecycle,
	registerHepiRuntimeLoadoutGroup,
} from "../../hepi-basics/src/core/index.js";
import { registerBashTool } from "./aft/bash.js";
import {
	appendToolResultBgCompletions,
	handlePushedBgCompletion,
	handlePushedBgLongRunning,
	handlePushedPatternMatch,
	handleSubcBgEventsNudge,
	handleTurnEndBgCompletions,
} from "./aft/bg-notifications.js";
import { loadAftConfig } from "./aft/config.js";
import { FffReadPathResolver } from "./aft/fff-read-path-resolver.js";
import { registerHoistedTools } from "./aft/hoisted.js";
import { registerImportTools } from "./aft/imports.js";
import { registerInspectTool } from "./aft/inspect.js";
import { registerNavigateTool } from "./aft/navigate.js";
import { registerRefactorTool } from "./aft/refactor.js";
import { HepiAftRuntime } from "./aft/runtime.js";
import { registerSafetyTool } from "./aft/safety.js";
import { resolveSessionId } from "./aft/shared.js";
import { signalSyncWatchAbort } from "./aft/sync-watch-abort.js";
import { type HepiAftToolSurface, resolveHepiAftToolSurface } from "./aft/tool-surface.js";
import { registerAftTools } from "./aft/tools.js";
import type { PluginContext } from "./aft/types.js";

export type HepiExtension = (pi: ExtensionAPI) => void;

export const HEPI_AFT_LOADOUT_GROUPS = [
	{ id: "aft-builtins", label: "built-in", items: ["read", "write", "edit", "bash"] },
	{
		id: "aft",
		label: "AFT",
		items: [
			"apply_patch",
			"bash_status",
			"bash_watch",
			"bash_write",
			"bash_kill",
			"aft_outline",
			"aft_zoom",
			"aft_safety",
			"aft_callgraph",
			"aft_refactor",
			"aft_import",
			"aft_inspect",
		],
	},
] as const satisfies readonly HepiLoadoutGroup[];

function loadoutGroups(surface: HepiAftToolSurface): readonly HepiLoadoutGroup[] {
	const builtins = [
		...(surface.read ? ["read"] : []),
		...(surface.write ? ["write"] : []),
		...(surface.edit ? ["edit"] : []),
		...(surface.bash ? ["bash"] : []),
	];
	const aft = [
		...(surface.applyPatch ? ["apply_patch"] : []),
		...(surface.bash ? ["bash_status", "bash_watch", "bash_write", "bash_kill"] : []),
		...(surface.outline ? ["aft_outline"] : []),
		...(surface.zoom ? ["aft_zoom"] : []),
		...(surface.safety ? ["aft_safety"] : []),
		...(surface.callgraph ? ["aft_callgraph"] : []),
		...(surface.refactor ? ["aft_refactor"] : []),
		...(surface.importTool ? ["aft_import"] : []),
		...(surface.inspect ? ["aft_inspect"] : []),
	];
	return [
		...(builtins.length > 0 ? [{ id: "aft-builtins", label: "built-in", items: builtins }] : []),
		...(aft.length > 0 ? [{ id: "aft", label: "AFT", items: aft }] : []),
	];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function registerHepiAft(pi: ExtensionAPI): void {
	let runtime: HepiAftRuntime | undefined;
	let readPathResolver: FffReadPathResolver | undefined;
	const config = loadAftConfig(process.cwd());
	const surface = resolveHepiAftToolSurface(config);
	if (!surface.enabled) return;
	const groups = loadoutGroups(surface);
	if (groups.length === 0) return;
	const context: PluginContext = {
		getRuntime: (): HepiAftRuntime => {
			if (runtime === undefined)
				throw new Error("AFT is unavailable. Start a new session or reload.");
			return runtime;
		},
		getReadPathResolver: (): FffReadPathResolver => {
			if (readPathResolver === undefined)
				throw new Error("AFT read path resolver is unavailable. Start a new session or reload.");
			return readPathResolver;
		},
		config,
		storageDir: resolveCortexKitStorageRoot(),
	};
	registerAftTools(pi, () => runtime, { outline: surface.outline, zoom: surface.zoom });
	registerHoistedTools(pi, context, {
		hoistRead: surface.read,
		hoistWrite: surface.write,
		hoistEdit: surface.edit,
		hoistGrep: false,
		hoistApplyPatch: surface.applyPatch,
		restrictToProjectRoot: surface.restrictToProjectRoot,
	});
	if (surface.safety) registerSafetyTool(pi, context);
	if (surface.bash) registerBashTool(pi, context);
	if (surface.callgraph) registerNavigateTool(pi, context);
	if (surface.refactor) registerRefactorTool(pi, context);
	if (surface.importTool) registerImportTools(pi, context);
	if (surface.inspect) registerInspectTool(pi, context);
	for (const group of groups) registerHepiRuntimeLoadoutGroup(pi, group);
	pi.on("tool_result", async (event, eventCtx) => {
		if (runtime === undefined) return;
		const sessionID = resolveSessionId(eventCtx);
		const content = await appendToolResultBgCompletions(
			{ ctx: context, directory: eventCtx.cwd, ...(sessionID === undefined ? {} : { sessionID }) },
			event.content,
		);
		if (content === undefined) return;
		return { content, details: event.details, isError: event.isError };
	});
	pi.on("turn_end", async (_event, eventCtx) => {
		if (runtime === undefined) return;
		const sessionID = resolveSessionId(eventCtx);
		await handleTurnEndBgCompletions({
			ctx: context,
			directory: eventCtx.cwd,
			...(sessionID === undefined ? {} : { sessionID }),
			runtime: pi,
		});
	});
	pi.on("input", (_event, eventCtx) => {
		signalSyncWatchAbort(resolveSessionId(eventCtx));
	});

	const lifecycle = new HepiLifecycleController({
		onStart: async (session) => {
			const activeRuntime = new HepiAftRuntime();
			const activeReadPathResolver = surface.read
				? new FffReadPathResolver(session.ctx.cwd)
				: undefined;
			try {
				await activeRuntime.start({
					poolOptions: {
						onBashCompletion: (completion) => {
							void handlePushedBgCompletion(
								{
									ctx: context,
									directory: session.ctx.cwd,
									sessionID: completion.session_id,
									runtime: pi,
								},
								completion,
							);
						},
						onBashLongRunning: (reminder) => {
							void handlePushedBgLongRunning(
								{
									ctx: context,
									directory: session.ctx.cwd,
									sessionID: reminder.session_id,
									runtime: pi,
								},
								reminder,
							);
						},
						onBashPatternMatch: (frame) => {
							void handlePushedPatternMatch(
								{
									ctx: context,
									directory: session.ctx.cwd,
									sessionID: frame.session_id,
									runtime: pi,
								},
								frame,
							);
						},
					},
					onBgEventsNudge: (directory, sessionID) => {
						void handleSubcBgEventsNudge({
							ctx: context,
							directory,
							sessionID,
							runtime: pi,
						});
					},
				});
			} catch (error) {
				if (session.ctx.hasUI)
					session.ctx.ui.notify(`AFT unavailable: ${errorMessage(error)}`, "warning");
				return;
			}
			runtime = activeRuntime;
			readPathResolver = activeReadPathResolver;
			session.registry.registerLifecycle({
				id: "aft-runtime",
				cleanup: async () => {
					activeReadPathResolver?.dispose();
					await activeRuntime.dispose();
					if (runtime === activeRuntime) runtime = undefined;
					if (readPathResolver === activeReadPathResolver) readPathResolver = undefined;
				},
			});
		},
	});
	registerHepiLifecycle(pi, lifecycle, "hepi-aft");
}

export const hepiAftExtensions: readonly HepiExtension[] = [registerHepiAft];

export default function piHepiAftExtension(pi: ExtensionAPI): void {
	for (const extension of hepiAftExtensions) extension(pi);
}
