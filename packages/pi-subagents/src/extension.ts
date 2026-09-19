import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle } from "@hheei/pi-ext-core";
import type { ChildIdentity } from "./domain.js";
import { isThinkingLevel } from "./domain.js";
import { createParentChannel, SubagentManager } from "./manager.js";
import { createSubagentRegistry } from "./registry.js";
import { launchDetachedRunner, recoverDetachedRunner } from "./runtime.js";
import { persistSubagentIntent, resolveSubagentLaunch } from "./session-bootstrap.js";
import { isChildEnvironment, registerChildTools, registerParentTools } from "./tools.js";

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

/** Test/integration seam for callers that own a fully composed manager. */
export function createSubagentsExtension(
	options: SubagentsExtensionOptions,
): (pi: ExtensionAPI) => void {
	return (pi) => {
		const child = childIdentityFromEnv(process.env);
		if (child !== undefined) {
			registerChildTools(pi, child);
			return;
		}
		const manager = options.createManager(pi);
		registerParentTools(pi, manager);
		pi.on("session_shutdown", () => manager.closeLocalConnections());
	};
}

export function validateChildEnvironment(
	env: NodeJS.ProcessEnv = process.env,
): ChildIdentity | undefined {
	return childIdentityFromEnv(env);
}

export default function piSubagentsExtension(pi: ExtensionAPI): void {
	const child = childIdentityFromEnv(process.env);
	if (child !== undefined) {
		registerChildTools(pi, child);
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
							content: `[Subagent ${report.childId}: ${report.reason}]\n${report.message}`,
							display: true,
							details: report,
						},
						{ triggerTurn: true, deliverAs: "nextTurn" },
					);
				},
			});
			const manager = new SubagentManager({
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
			runtime.resources.add("subagent-manager", () => manager.closeLocalConnections());
		},
	});
}
