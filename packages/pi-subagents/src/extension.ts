import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { registerChildBridge } from "./child-bridge.js";
import { bindParentStatus, registerParentCommands } from "./commands.js";
import type { ChildIdentity } from "./domain.js";
import { BRIDGE_ENVIRONMENT_KEYS, isThinkingLevel } from "./domain.js";
import {
	createCmuxHostAdapter,
	createHerdrHostAdapter,
	selectHostAdapter,
} from "./host-adapter.js";
import { type ParentChannelReport, SubagentManager } from "./manager.js";
import { createSubagentRegistry } from "./registry.js";
import { createRuntimeTokenStore, launchDetachedRunner, recoverDetachedRunner } from "./runtime.js";
import { persistSubagentIntent, resolveSubagentLaunch } from "./session-bootstrap.js";
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
			const channel = {
				async deliver(report: ParentChannelReport): Promise<void> {
					pi.sendMessage(
						{
							customType: "pi-subagent-report",
							content: `[Subagent ${report.agent} ${report.childId}: ${report.reason}]\n${report.message}`,
							display: true,
							details: report,
						},
						{ triggerTurn: true, deliverAs: "nextTurn" },
					);
				},
			};
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
