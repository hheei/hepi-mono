import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import {
	type BackgroundDelivery,
	errorMessage,
	getBackgroundDelivery,
	registerExtensionLifecycle,
	TASK_REGISTRY_SERVICE_KEY,
	type TaskRegistry,
	waitForService,
} from "@hheei/pi-ext-core";
import type { SkillCatalogEntry } from "./agent-resolver.js";
import { ChildBridgeServer } from "./bridge-server.js";
import { registerChildBridge } from "./child-bridge.js";
import { bindParentStatus, registerParentCommands } from "./commands.js";
import type { ChildIdentity } from "./domain.js";
import { BRIDGE_ENVIRONMENT_KEYS, isThinkingLevel } from "./domain.js";
import {
	createCmuxHostAdapter,
	createHerdrHostAdapter,
	type HostAttachmentIdentity,
	selectHostAdapter,
} from "./host-adapter.js";
import { type ParentChannel, type ParentChannelReport, SubagentManager } from "./manager.js";
import { transformSubagentsMarkdown } from "./markdown.js";
import { createSubagentRegistry } from "./registry.js";
import {
	createRuntimeTokenStore,
	launchChild,
	openChildPanel,
	parentBridgeEndpoint,
	prepareRuntimeDirectory,
} from "./runtime.js";
import { persistSubagentIntent, resolveSubagentLaunch } from "./session-bootstrap.js";
import { registerInteractiveToolActivation } from "./tool-activation.js";
import { registerParentTools } from "./tools.js";
import { createSubagentWidget } from "./widget.js";

const CHILD_ENV_KEYS = Object.values(BRIDGE_ENVIRONMENT_KEYS);

/** How long startup waits for a child that survived a parent restart to reconnect its bridge. */
const ADOPT_WINDOW_MS = 5_000;

function diagnose(message: string): void {
	if (process.env.DEBUG || process.env.PI_SUBAGENTS_DEBUG) {
		console.error(`pi-subagents: ${message}`);
	}
}

/** Parent channel plus the teardown its owner must call. */
export interface ParentChannelHandle extends ParentChannel {
	/** Unregisters delivery and appends anything still held without waking the parent. */
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
 * Busy parents receive a steer into the next model step. Idle parents wait until all registered
 * background work finishes; decision requests and blockers bypass that wait. The shared gate
 * coordinates this channel with Task/Bash results so only one message requests a new idle turn.
 */
export function createParentChannel(
	pi: Pick<ExtensionAPI, "sendMessage" | "on">,
	deps: {
		readonly isIdle: () => boolean;
		readonly delivery: BackgroundDelivery;
		readonly signal?: AbortSignal;
	},
): ParentChannelHandle {
	const held: ParentChannelReport[] = [];
	let disposed = false;

	const flush = (triggerTurn: boolean, urgentOnly = false): void => {
		if (held.length === 0) return;
		const reports = urgentOnly ? held.filter((report) => report.reason === "blocked") : [...held];
		if (reports.length === 0) return;
		for (const report of reports) held.splice(held.indexOf(report), 1);
		try {
			pi.sendMessage(
				{
					customType: "pi-subagent-report",
					content: reports.map(reportText).join("\n\n"),
					display: true,
					details: { reports },
				},
				{ triggerTurn, deliverAs: "steer" },
			);
		} catch (error) {
			held.unshift(...reports);
			throw error;
		}
	};

	const registration = deps.delivery.registerChannel({
		isIdle: deps.isIdle,
		hasPending: () => !deps.signal?.aborted && held.length > 0,
		flush,
	});
	const stopWatching = pi.on("agent_start", () => registration.request());
	const stopSettled = pi.on("agent_settled", () => registration.request());

	return {
		async deliver(report: ParentChannelReport): Promise<void> {
			if (disposed) throw new Error("Parent report channel is disposed");
			held.push(report);
			registration.request(report.reason === "blocked");
		},
		dispose(): void {
			disposed = true;
			registration.dispose();
			stopWatching();
			stopSettled();
			// The session is going away, so the held reports are appended for the record without
			// starting a run in a parent that is being torn down.
			flush(false);
		},
	};
}

/**
 * Pi publishes the skills it loaded with every prompt; a definition names them the same way, so
 * the launch path needs exactly the name and the file path from that list.
 */
export function skillCatalogFromLoaded(skills: readonly Skill[]): readonly SkillCatalogEntry[] {
	return skills.map((skill) => ({ name: skill.name, path: skill.filePath }));
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
			const tokens = createRuntimeTokenStore({ parentSessionId, diagnose });
			// Presentation is chosen once per parent session: herdr first, then cmux, and a parent with
			// neither runs every child in the background. Successful selection stays silent; only actual
			// failures and fallback diagnostics are reported by the launch path.
			const ownerId = parentSessionId;
			const ownsAttachment = (identity: HostAttachmentIdentity): boolean =>
				identity.createdBy === ownerId;
			const hostSelection = await selectHostAdapter({
				adapters: {
					herdr: createHerdrHostAdapter({ ownerId, ownsAttachment }),
					cmux: createCmuxHostAdapter({ ownerId, ownsAttachment }),
				},
			});
			const delivery = getBackgroundDelivery(pi);
			const channel = createParentChannel(pi, {
				isIdle: () => context.isIdle(),
				delivery,
				signal: runtime.signal,
			});
			runtime.resources.add("parent-channel", () => channel.dispose());
			let manager!: SubagentManager;
			// The parent listens; every child dials this socket, so the bridge connection is both the
			// control plane and the only honest answer to "is this child still running?".
			const server = new ChildBridgeServer({
				endpoint: parentBridgeEndpoint(parentSessionId),
				parentSessionId,
				authorize: async (frame) => {
					const expected = tokens.get(frame.runtimeIdentity);
					if (expected === undefined) {
						return `no bridge token is recorded for runtime ${frame.runtimeIdentity}`;
					}
					if (expected !== frame.token) return "bridge token mismatch";
					// The token says which runtime is calling; the registry says which child that runtime
					// belongs to. Without this check a child could name another child's id and take over
					// its control channel, so a hello that does not match its record is refused.
					const record = await registry.get(frame.subagentId).catch(() => undefined);
					if (record === undefined) return `no recorded child ${frame.subagentId}`;
					if (record.runtime?.runtimeIdentity !== frame.runtimeIdentity) {
						return `runtime ${frame.runtimeIdentity} is not the recorded runtime of child ${frame.subagentId}`;
					}
					return undefined;
				},
				handleRequest: (request) =>
					manager.handleChildRequest(request.childId, request.operation, request.payload),
				diagnose,
			});
			await prepareRuntimeDirectory(diagnose);
			await server.listen();
			// Closing is awaited: the endpoint is unlinked after the server is closed, so a reload that
			// started the next server first could have this close unlink the new socket path.
			runtime.resources.add("subagent-bridge", () => server.close());
			// A definition names skills the way Pi lists them, so the parent's loaded skill set is
			// the only name → path catalog; Pi hands it over before every prompt of this session.
			let skillCatalog: readonly SkillCatalogEntry[] = [];
			const unsubscribeSkillCatalog = pi.on("before_agent_start", (event) => {
				skillCatalog = skillCatalogFromLoaded(event.systemPromptOptions.skills);
			});
			runtime.resources.add("subagent-skill-catalog", unsubscribeSkillCatalog);

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
					const records = await registry.list().catch(() => []);
					const existingSubagentIds = records.map((record) => record.subagentId);
					return resolveSubagentLaunch({
						input,
						cwd: context.cwd,
						modelRegistry: context.modelRegistry,
						skillCatalog,
						existingSubagentIds,
						enforceEnabled: true,
						onWarning: (message) => context.ui.notify(message, "warning"),
						parent: {
							model: { provider: model.provider, id: model.id },
							thinking,
						},
					});
				},
				bootstrap(input) {
					return persistSubagentIntent({ registry, ...input });
				},
				bridge: server,
				launch(record) {
					return launchChild({
						registry,
						record,
						tokens,
						waitForBridge: (childId, signal) =>
							server.waitForConnection(childId, {
								timeoutMs: ADOPT_WINDOW_MS,
								...(signal === undefined ? {} : { signal }),
							}),
						signal: runtime.signal,
						diagnose,
					});
				},
				presentation: {
					reason: hostSelection.reason,
					...(hostSelection.available
						? {
								openPanel: (record) =>
									openChildPanel({
										registry,
										record,
										tokens,
										host: hostSelection.adapter,
										waitForBridge: (childId, signal) =>
											server.waitForConnection(childId, {
												timeoutMs: ADOPT_WINDOW_MS,
												...(signal === undefined ? {} : { signal }),
											}),
										signal: runtime.signal,
										diagnose,
									}),
							}
						: {}),
				},
				// Adoption is a wait, never a spawn: a child that survived this parent reconnects on
				// its own, and one that did not stays recorded until a send starts it again.
				connect(record) {
					return server.waitForConnection(record.subagentId, {
						timeoutMs: ADOPT_WINDOW_MS,
						signal: runtime.signal,
					});
				},
			});
			const unregisterWork = delivery.registerSource({
				activeCount: () => manager.activeCount,
				onChange: (listener) => manager.onChange(listener),
			});
			runtime.resources.add("subagent-background-work", unregisterWork);
			// Recovery must never take the extension down with it: a registry this version cannot
			// read (for example records written by an older release) is reported in the session and
			// the user is told how to reset it.
			const recovery = await manager.recover().catch((error: unknown) => ({
				recovered: [],
				failures: [
					{
						childId: "registry",
						reason: `${errorMessage(error)}. Delete the stale records (or the whole registry file) to reset this parent session's subagent state.`,
					},
				],
			}));
			if (recovery.failures.length > 0) {
				context.ui.notify(
					`Subagent recovery failed:\n${recovery.failures
						.map((failure) => `- ${failure.childId}: ${failure.reason}`)
						.join("\n")}`,
					"error",
				);
			}
			registerParentTools(pi, manager);
			if (typeof pi.registerMarkdownTransformer === "function") {
				pi.registerMarkdownTransformer(transformSubagentsMarkdown);
			}
			const activation = registerInteractiveToolActivation({
				pi,
				manager,
				context,
			});
			runtime.resources.add("interactive-tool-activation", () => activation.dispose());
			registerParentCommands(pi, manager);
			void waitForService(pi, TASK_REGISTRY_SERVICE_KEY, { signal: runtime.signal })
				.then((taskRegistry: TaskRegistry) => {
					if (runtime.signal.aborted) return;
					const unbind = manager.bindTaskRegistry(taskRegistry);
					runtime.resources.add("subagent-task-registry", unbind);
				})
				.catch((error: unknown) => {
					diagnose(`Task registry service unavailable for subagents: ${errorMessage(error)}`);
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
