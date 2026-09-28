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
 * How a child report reaches the parent conversation. `followUp` appends it to the run in flight,
 * or starts a turn when the parent is idle, so the parent reads the report as part of its next
 * activity; `nextTurn` would instead park it until the user's next message.
 */
export function createParentChannel(pi: Pick<ExtensionAPI, "sendMessage">): ParentChannel {
	return {
		async deliver(report: ParentChannelReport): Promise<void> {
			pi.sendMessage(
				{
					customType: "pi-subagent-report",
					content: `[Subagent ${report.agent} ${report.childId}: ${report.reason}]\n${report.message}`,
					display: true,
					details: report,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
	};
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
			const channel = createParentChannel(pi);
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
