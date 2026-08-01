import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionLifecycleContext, SubagentId, TaskSubagentSpec } from "@hheei/pi-ext-core";
import { configureSubagentCoordinator, startSubagent } from "@hheei/pi-ext-core";
import type { SubagentsConfiguration } from "./config.js";
import { DEFAULT_MAX_ACTIVE_TURNS, loadSubagentsConfiguration } from "./config.js";
import { renderTaskTerminalAnchor } from "./delivery.js";
import { createChildSessionFactory } from "./factory.js";
import { resolveProfile } from "./profiles.js";

export interface SubagentsFeature {
	start(runtime: ExtensionLifecycleContext): Promise<void>;
	launch(
		args: {
			readonly task: string;
			readonly prompt: string;
			readonly agent: string;
			readonly maxTurns: number;
		},
		signal: AbortSignal | undefined,
		context: ExtensionContext,
	): Promise<SubagentsToolResult>;
}

interface SubagentsToolResult {
	readonly content: { readonly type: "text"; readonly text: string }[];
	readonly details: undefined;
	readonly isError?: true;
}

export interface SubagentsFeatureOptions {
	readonly loadConfiguration?: typeof loadSubagentsConfiguration;
	readonly resolveProfile?: typeof resolveProfile;
	readonly createFactory?: typeof createChildSessionFactory;
	readonly startTask?: (
		runtime: ExtensionLifecycleContext,
		spec: TaskSubagentSpec,
	) => { readonly id: SubagentId };
	readonly configureCoordinator?: (
		runtime: ExtensionLifecycleContext,
		options: { readonly maxActiveTurns: number },
	) => void;
}

interface ActiveSubagentsFeature {
	readonly runtime: ExtensionLifecycleContext;
	readonly configuration: SubagentsConfiguration;
	disposed: boolean;
}

function toolError(text: string): SubagentsToolResult {
	return { content: [{ type: "text", text }], details: undefined, isError: true };
}

function activeForContext(
	active: ActiveSubagentsFeature | undefined,
	context: ExtensionContext,
): active is ActiveSubagentsFeature {
	return (
		active !== undefined &&
		!active.disposed &&
		!active.runtime.signal.aborted &&
		active.runtime.extension.sessionManager.getSessionId() === context.sessionManager.getSessionId()
	);
}

/** Session-owned task launcher. Terminal delivery is queued to the parent as a follow-up turn. */
export function createSubagentsFeature(
	pi: ExtensionAPI,
	options: SubagentsFeatureOptions = {},
): SubagentsFeature {
	const loadConfiguration = options.loadConfiguration ?? loadSubagentsConfiguration;
	const resolve = options.resolveProfile ?? resolveProfile;
	const createFactory = options.createFactory ?? createChildSessionFactory;
	const startTask =
		options.startTask ??
		((runtime: ExtensionLifecycleContext, spec: TaskSubagentSpec): { readonly id: SubagentId } =>
			startSubagent(runtime, spec));
	const configure = options.configureCoordinator ?? configureSubagentCoordinator;
	let active: ActiveSubagentsFeature | undefined;

	return {
		async start(runtime: ExtensionLifecycleContext): Promise<void> {
			let configuration: SubagentsConfiguration;
			try {
				configuration = await loadConfiguration(undefined, runtime.signal);
			} catch {
				configuration = {
					maxActiveTurns: DEFAULT_MAX_ACTIVE_TURNS,
					state: { kind: "invalid", reason: "Unable to load pi-subagents settings" },
					warnings: [],
				};
			}
			configure(runtime, { maxActiveTurns: configuration.maxActiveTurns });
			const current: ActiveSubagentsFeature = { runtime, configuration, disposed: false };
			active = current;
			runtime.resources.add("subagents", () => {
				current.disposed = true;
				if (active === current) active = undefined;
			});
		},
		async launch(args, signal, context) {
			const current = active;
			if (!activeForContext(current, context))
				return toolError("pi-subagents is not active for this session.");
			if (signal?.aborted) return toolError("Agent task launch was cancelled.");
			if (current.configuration.state.kind === "invalid")
				return toolError(
					`Invalid pi-subagents configuration: ${current.configuration.state.reason}`,
				);
			try {
				const profile = await resolve({
					cwd: current.runtime.extension.cwd,
					name: args.agent,
					modelRegistry: current.runtime.extension.modelRegistry,
					...(signal === undefined ? {} : { signal }),
				});
				if (!activeForContext(active, context) || active !== current || signal?.aborted)
					return toolError("Agent task launch was cancelled.");
				const session = createFactory(profile, {
					cwd: current.runtime.extension.cwd,
					modelRegistry: current.runtime.extension.modelRegistry,
					...(current.runtime.extension.model === undefined
						? {}
						: { parentModel: current.runtime.extension.model }),
				});
				const handle = startTask(current.runtime, {
					mode: "task",
					session,
					prompt: args.prompt,
					maxTurns: args.maxTurns,
					delivery: (result, deliverySignal) => {
						if (
							deliverySignal.aborted ||
							current.disposed ||
							current.runtime.signal.aborted ||
							active !== current
						)
							return;
						pi.sendMessage(
							{
								customType: "pi-subagents-terminal",
								content: renderTaskTerminalAnchor(result, args.task),
								display: true,
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
					},
				});
				return {
					content: [{ type: "text", text: JSON.stringify({ accepted: true, id: handle.id }) }],
					details: undefined,
				};
			} catch (error) {
				return toolError(
					`Agent task rejected: ${error instanceof Error ? error.message : "invalid profile"}`,
				);
			}
		},
	};
}
