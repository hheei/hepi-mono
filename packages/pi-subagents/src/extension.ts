import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { registerChildNudge } from "./child-nudge.js";
import type { ChildIdentity } from "./domain.js";
import { CHILD_AGENT_ENV_KEY, isThinkingLevel } from "./domain.js";
import {
	createCmuxHostAdapter,
	createHerdrHostAdapter,
	selectHostAdapter,
} from "./host-adapter.js";
import { createParentChannel, SubagentManager } from "./manager.js";
import { createSubagentRegistry } from "./registry.js";
import { launchDetachedRunner, recoverDetachedRunner, runtimeToken } from "./runtime.js";
import { persistSubagentIntent, resolveSubagentLaunch } from "./session-bootstrap.js";
import { isChildEnvironment, registerChildTools, registerParentTools } from "./tools.js";
import { createChildIdentityWidget, createSubagentWidget } from "./widget.js";

export interface SubagentsExtensionOptions {
	readonly createManager: (pi: ExtensionAPI) => SubagentManager;
}

const CHILD_ENV_KEYS = [
	"PI_SUBAGENTS_PARENT_SESSION_ID",
	"PI_SUBAGENTS_CHILD_ID",
	"PI_SUBAGENTS_RUNTIME_ID",
	"PI_SUBAGENTS_ENDPOINT",
	"PI_SUBAGENTS_TOKEN",
] as const;

function childIdentityFromEnv(env: NodeJS.ProcessEnv): ChildIdentity | undefined {
	const present = CHILD_ENV_KEYS.filter((key) => env[key] !== undefined);
	if (present.length === 0) return undefined;
	if (!isChildEnvironment(env))
		throw new Error("Invalid partial pi-subagents child identity environment");
	return {
		parentSessionId: env.PI_SUBAGENTS_PARENT_SESSION_ID,
		subagentId: env.PI_SUBAGENTS_CHILD_ID,
		runtimeIdentity: env.PI_SUBAGENTS_RUNTIME_ID,
		endpoint: env.PI_SUBAGENTS_ENDPOINT,
		token: env.PI_SUBAGENTS_TOKEN,
	};
}

function registerChildBranch(pi: ExtensionAPI, child: ChildIdentity): void {
	const nudge = registerChildNudge(pi);
	registerChildTools(pi, child, () => nudge.markReported());
	const stop = new AbortController();
	let identityWidget: { dispose(): void } | undefined;
	pi.on("session_start", (_event, ctx) => {
		const tools = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
		identityWidget = createChildIdentityWidget(pi, ctx, stop.signal, {
			agent: process.env[CHILD_AGENT_ENV_KEY] ?? "",
			toolCount: tools.length,
		});
	});
	pi.on("session_shutdown", () => {
		stop.abort();
		identityWidget?.dispose();
		nudge.dispose();
	});
}

/** Test/integration seam for callers that own a fully composed manager. */
export function createSubagentsExtension(
	options: SubagentsExtensionOptions,
): (pi: ExtensionAPI) => void {
	return (pi) => {
		const child = childIdentityFromEnv(process.env);
		if (child !== undefined) {
			registerChildBranch(pi, child);
			return;
		}
		const manager = options.createManager(pi);
		registerParentTools(pi, manager);
		registerAttachCommand(pi, manager);
		pi.on("session_shutdown", () => manager.closeLocalConnections());
	};
}

export function validateChildEnvironment(
	env: NodeJS.ProcessEnv = process.env,
): ChildIdentity | undefined {
	return childIdentityFromEnv(env);
}

function registerAttachCommand(pi: ExtensionAPI, manager: SubagentManager): void {
	pi.registerCommand("attach-subagent", {
		description: "Open an idle RPC child as a native Pi TUI. The session must already be flushed.",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (id === "") {
				ctx.ui.notify("Usage: /attach-subagent <child-id>", "warning");
				return;
			}
			const result = await manager.attach(id);
			if ("reason" in result) {
				ctx.ui.notify(`Attach failed: ${result.reason}`, "error");
				return;
			}
			ctx.ui.notify(`Attached ${result.child.id} on ${result.host} (${result.attachmentId})`);
		},
	});
}

export default function piSubagentsExtension(pi: ExtensionAPI): void {
	const child = childIdentityFromEnv(process.env);
	if (child !== undefined) {
		registerChildBranch(pi, child);
		return;
	}
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-subagents",
		async start(runtime): Promise<void> {
			const context = runtime.extension;
			const parentSessionId = context.sessionManager.getSessionId();
			const registry = createSubagentRegistry({ parentSessionId });
			const channel = createParentChannel({
				async deliverOnline(report): Promise<void> {
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
			});
			let manager!: SubagentManager;
			const ownsAttachment = (identity: {
				readonly host: "herdr" | "cmux";
				readonly attachmentId: string;
			}) => manager.ownsHostAttachment(identity);
			manager = new SubagentManager({
				parentSessionId,
				registry,
				channel,
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
					return launchDetachedRunner({ registry, record, signal: runtime.signal });
				},
				connect(record) {
					return recoverDetachedRunner({ registry, record, signal: runtime.signal });
				},
				bridgeToken: runtimeToken,
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
			registerAttachCommand(pi, manager);
			const widget = createSubagentWidget(pi, context, runtime.signal);
			const refreshWidget = (): void => {
				void manager.list().then((children) => widget?.refresh(children));
			};
			const unsubscribe = manager.onChange(refreshWidget);
			refreshWidget();
			runtime.resources.add("subagent-widget", () => {
				unsubscribe();
				widget?.dispose();
			});
			runtime.resources.add("subagent-manager", () => manager.closeLocalConnections());
		},
	});
}
