import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getToolTui, registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { registerChildBridge } from "./child-bridge.js";
import { bindParentStatus, registerParentCommands } from "./commands.js";
import type { ChildIdentity } from "./domain.js";
import { BRIDGE_ENVIRONMENT_KEYS, isOperationError, isThinkingLevel } from "./domain.js";
import {
	createCmuxHostAdapter,
	createHerdrHostAdapter,
	selectHostAdapter,
} from "./host-adapter.js";
import { type ParentChannel, type ParentChannelReport, SubagentManager } from "./manager.js";
import { createSubagentRegistry } from "./registry.js";
import { createRuntimeTokenStore, launchDetachedRunner, recoverDetachedRunner } from "./runtime.js";
import { persistSubagentIntent, resolveSubagentLaunch } from "./session-bootstrap.js";
import { AgentTaskExecutor } from "./task-executor.js";
import { registerTaskTool } from "./task-tool.js";
import { registerParentTools } from "./tools.js";
import { createSubagentWidget } from "./widget.js";

const CHILD_ENV_KEYS = Object.values(BRIDGE_ENVIRONMENT_KEYS);

/**
 * Fixed window that merges reports from several children into one follow-up while the parent is
 * idle. Reports that arrive during a run are appended to it without waiting.
 */
export const REPORT_MERGE_WINDOW_MS = 30_000;

/** Parent channel plus the teardown its owner must call. */
export interface ParentChannelHandle extends ParentChannel {
	/** Stops the window and appends anything still held without waking the parent. */
	dispose(): void;
}

function requiredBridgeValue(env: NodeJS.ProcessEnv, key: string): string {
	const value = env[key];
	if (typeof value !== "string" || value === "") {
		throw new Error("Invalid partial pi-subagents child identity environment");
	}
	return value;
}

function childIdentityFromEnv(env: NodeJS.ProcessEnv): ChildIdentity | undefined {
	const present = CHILD_ENV_KEYS.filter((key) => env[key] !== undefined);
	if (present.length === 0) return undefined;
	return {
		parentSessionId: requiredBridgeValue(env, BRIDGE_ENVIRONMENT_KEYS.parentSessionId),
		subagentId: requiredBridgeValue(env, BRIDGE_ENVIRONMENT_KEYS.childId),
		runtimeIdentity: requiredBridgeValue(env, BRIDGE_ENVIRONMENT_KEYS.runtimeId),
		endpoint: requiredBridgeValue(env, BRIDGE_ENVIRONMENT_KEYS.endpoint),
		token: requiredBridgeValue(env, BRIDGE_ENVIRONMENT_KEYS.token),
	};
}

/**
 * How child reports reach the parent conversation.
 *
 * A report is appended to the run in flight when the parent is busy, and starts a turn when the
 * parent is idle. While the parent is idle the first report also opens a fixed merge window, so
 * several children finishing close together become one follow-up instead of one turn each; the
 * window is never extended by a later report, and a parent that starts its own activity takes
 * whatever is held along with it. `nextTurn` is never used: it parks a report until the user's
 * next message, which is not what a finished child owes the parent. Every delivery asks for a
 * turn (`followUp`), which the host batches while the parent is busy and queues for the run in
 * flight; only teardown appends without asking for one, because the session is going away.
 */
export function createParentChannel(
	pi: Pick<ExtensionAPI, "sendMessage" | "on">,
	deps: { readonly isIdle: () => boolean; readonly windowMs?: number },
): ParentChannelHandle {
	const windowMs = deps.windowMs ?? REPORT_MERGE_WINDOW_MS;
	const held: ParentChannelReport[] = [];
	let window: NodeJS.Timeout | undefined;
	let disposed = false;

	const flush = (triggerTurn: boolean): void => {
		if (window !== undefined) clearTimeout(window);
		window = undefined;
		if (held.length === 0) return;
		const reports = held.splice(0, held.length);
		pi.sendMessage(
			{
				customType: "pi-subagent-report",
				content: reports.map(reportText).join("\n\n"),
				display: true,
				details: { reports },
			},
			{ triggerTurn, deliverAs: "followUp" },
		);
	};

	// The parent starting its own run is the next activity the held reports belong to, so they are
	// queued for that run: a report appended without asking for a turn can sit unread until the user
	// speaks again, which is exactly what a finished child must not do.
	const stopWatching = pi.on("agent_start", () => {
		if (!disposed) flush(true);
	});

	return {
		async deliver(report: ParentChannelReport): Promise<void> {
			held.push(report);
			if (!deps.isIdle()) {
				// Busy parent: the host batches queued follow-ups, so this joins the run in flight.
				flush(true);
				return;
			}
			if (window !== undefined) return;
			window = setTimeout(() => {
				if (!disposed) flush(true);
			}, windowMs);
			window.unref?.();
		},
		dispose(): void {
			disposed = true;
			stopWatching();
			// The session is going away, so the held reports are appended for the record without
			// starting a run in a parent that is being torn down.
			flush(false);
		},
	};
}

function reportText(report: ParentChannelReport): string {
	return `[Subagent ${report.agent} ${report.childId}: ${report.reason}]\n${report.message}`;
}

export default function piSubagentsExtension(pi: ExtensionAPI): void {
	const child = childIdentityFromEnv(process.env);
	if (child !== undefined) {
		registerChildBridge(pi, child);
		return;
	}
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-subagents",
		async start(runtime): Promise<void> {
			const context = runtime.extension;
			const parentSessionId = context.sessionManager.getSessionId();
			const registry = createSubagentRegistry({ parentSessionId });
			const tokens = createRuntimeTokenStore();
			const channel = createParentChannel(pi, { isIdle: () => context.isIdle() });
			runtime.resources.add("parent-channel", () => channel.dispose());
			let manager!: SubagentManager;
			const ownsAttachment = (identity: {
				readonly host: "herdr" | "cmux";
				readonly attachmentId: string;
			}) => manager.ownsHostAttachment(identity);
			manager = new SubagentManager({
				parentSessionId,
				registry,
				channel,
				tokens,
				async resolve(input) {
					const model = context.model;
					if (model === undefined) throw new Error("No parent model is selected");
					const thinking = context.thinkingLevel ?? pi.getThinkingLevel();
					if (!isThinkingLevel(thinking)) {
						throw new Error(`Unsupported parent thinking level: ${thinking}`);
					}
					return resolveSubagentLaunch({
						input,
						cwd: context.cwd,
						modelRegistry: context.modelRegistry,
						parent: {
							model: { provider: model.provider, id: model.id },
							thinking,
						},
					});
				},
				bootstrap(input) {
					return persistSubagentIntent({ registry, ...input });
				},
				launch(record) {
					return launchDetachedRunner({
						registry,
						record,
						tokens,
						signal: runtime.signal,
					});
				},
				connect(record) {
					return recoverDetachedRunner({
						registry,
						record,
						tokens,
						signal: runtime.signal,
					});
				},
				attachHost: {
					select(preferredHost) {
						return selectHostAdapter({
							adapters: {
								herdr: createHerdrHostAdapter({
									ownerId: parentSessionId,
									ownsAttachment,
								}),
								cmux: createCmuxHostAdapter({
									ownerId: parentSessionId,
									ownsAttachment,
								}),
							},
							...(preferredHost === undefined ? {} : { preferredHost }),
						});
					},
				},
			});
			const recovery = await manager.recover();
			if (recovery.failures.length > 0) {
				pi.sendMessage(
					{
						customType: "pi-subagent-recovery-failure",
						content: `Subagent recovery failed:\n${recovery.failures
							.map((failure) => `- ${failure.childId}: ${failure.reason}`)
							.join("\n")}`,
						display: true,
						details: recovery.failures,
					},
					{ triggerTurn: false },
				);
			}
			registerParentTools(pi, manager);
			registerParentCommands(pi, manager);
			// One `task` call becomes one dedicated child plus one shared-registry entry. The child
			// is spawned through the same RPC launch path as a conversation child, and is never
			// resumed or attached afterwards.
			registerTaskTool(runtime, getToolTui(pi), (taskRegistry) => {
				const executor = new AgentTaskExecutor({
					registry: taskRegistry,
					async launch(request) {
						const spawned = await manager.spawn({
							agent: request.agent,
							task: request.task,
							...(request.cwd === undefined ? {} : { cwd: request.cwd }),
							taskContract: request.contract,
						});
						if (isOperationError(spawned)) {
							throw new Error(`${spawned.operation} failed: ${spawned.reason}`);
						}
						return { childId: spawned.child.id };
					},
					async stopChild(childId) {
						const stopped = await manager.stop(childId);
						return !isOperationError(stopped);
					},
					onCleanupFailure(childId, reason) {
						console.error(`pi-subagents: task child ${childId} cleanup: ${reason}`);
					},
				});
				const unsubscribeTaskEvents = manager.onChildEvent((childId, event) => {
					executor.handleChildEvent(childId, event);
				});
				runtime.resources.add("subagent-task-events", () => unsubscribeTaskEvents());
				return executor;
			});
			const widget = createSubagentWidget(pi, context, runtime.signal);
			const refreshWidget = (): void => {
				if (runtime.signal.aborted) return;
				void manager
					.list()
					.then((children) => {
						if (runtime.signal.aborted) return;
						widget?.refresh(children);
					})
					.catch(() => {});
			};
			const unsubscribe = manager.onChange(refreshWidget);
			const unbindStatus = bindParentStatus(pi, context, manager, runtime.signal);
			refreshWidget();
			runtime.resources.add("subagent-widget", () => {
				unsubscribe();
				unbindStatus();
				widget?.dispose();
			});
			runtime.resources.add("subagent-manager", () => manager.closeLocalConnections());
		},
	});
}
