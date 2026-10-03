import { errorMessage, isRecord, type TaskRegistry } from "@hheei/pi-ext-core";
import type { ChildRuntime } from "./child-process.js";
import type {
	EffectiveLaunchConfig,
	OperationError,
	Presentation,
	PublicSubagent,
	SendMode,
	SpawnSubagentInput,
	SubagentRecord,
	SubagentState,
} from "./domain.js";
import type { HostAttachment } from "./host-adapter.js";
import { stripHindsightContent } from "./launch-spec.js";
import {
	BridgeError,
	type BridgeOperation,
	isChildInputPayload,
	isChildLifecyclePayload,
	isContactReportPayload,
} from "./protocol.js";
import type { SubagentRegistry } from "./registry.js";
import type { LaunchOutcome, RuntimeTokenStore } from "./runtime.js";
import { findSessionFile, planSessionPlacement } from "./session-bootstrap.js";
import { readSessionJsonlEntries } from "./session-fork.js";
import { createStateProjector, type StateProjector } from "./state.js";

/**
 * How long an idle child keeps its runtime. A background child holds a whole Pi process and its
 * session lock, so an idle one is reclaimed after this window and a later `send_agent` starts it
 * again from the same session.
 */
export const SUBAGENT_IDLE_TIMEOUT_MS = 60_000;

/** How long stop waits for an adopted child's bridge to go away before calling the exit unconfirmed. */
export const SUBAGENT_EXIT_WAIT_MS = 2_000;

const STOPPED_SEND_REASON =
	"Child is stopped; a stopped child never resumes — spawn a new child if this work is still needed";

function diagnose(message: string): void {
	if (process.env.DEBUG || process.env.PI_SUBAGENTS_DEBUG) {
		console.error(`pi-subagents: ${message}`);
	}
}

export interface ParentChannelReport {
	readonly parentSessionId: string;
	readonly childId: string;
	readonly agent: string;
	readonly task: string;
	readonly status: SubagentState;
	readonly reason: string;
	readonly message: string;
}

export interface ParentChannel {
	deliver(report: ParentChannelReport): Promise<void>;
}

/**
 * The parent side of the bridge, as the manager needs it: one connection per child, requests the
 * parent may send, and the events and connection transitions the child reports. Liveness is a
 * connection: no other channel can say whether this child is still running.
 */
export interface ChildBridgeTransport {
	isConnected(childId: string): boolean;
	/** Ends a child's connection from this side, for a process that stopped being this child. */
	disconnect(childId: string): void;
	request(
		childId: string,
		operation: BridgeOperation,
		payload?: unknown,
		options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
	): Promise<unknown>;
	onEvent(listener: (childId: string, event: unknown) => void): () => void;
	onConnectionChange(listener: (childId: string, connected: boolean) => void): () => void;
}

export interface ManagerDependencies {
	readonly parentSessionId: string;
	readonly registry: Pick<SubagentRegistry, "get" | "list" | "update">;
	readonly resolve: (input: SpawnSubagentInput) => Promise<EffectiveLaunchConfig>;
	readonly bootstrap: (input: {
		readonly parentSessionId: string;
		readonly task: string;
		readonly launchConfig: EffectiveLaunchConfig;
		readonly presentation: Presentation;
	}) => Promise<SubagentRecord>;
	readonly bridge: ChildBridgeTransport;
	/** Starts a background runtime for this record and resolves once the child has connected. */
	readonly launch: (record: SubagentRecord) => Promise<LaunchOutcome<ChildRuntime>>;
	/**
	 * Presentation hosts of this parent. Absent when no panel host is available, in which case every
	 * child runs in the background; `hostReason` is what the spawn result tells the caller, so a
	 * fallback is visible instead of silent.
	 */
	readonly presentation?: PresentationDeps;
	/** Waits for an already-running runtime to reconnect; false when it does not. */
	readonly connect: (record: SubagentRecord) => Promise<boolean>;
	readonly deadlineMs?: number;
	readonly idleTimeoutMs?: number;
	readonly failedPanelCloseTimeoutMs?: number;
	readonly channel?: ParentChannel;
	readonly tokens?: RuntimeTokenStore;
}

/**
 * How this parent presents children, as the manager needs it: something that opens a panel for a
 * record and resolves once the child has connected, plus the reason for that state of affairs,
 * which is said out loud when a child falls back to the background.
 */
export interface PresentationDeps {
	readonly reason: string;
	/** Absent when this parent has no presentation host, which makes every child a background one. */
	readonly openPanel?: (record: SubagentRecord) => Promise<LaunchOutcome<HostAttachment>>;
}

export interface SpawnResult {
	readonly child: PublicSubagent;
	/** Set when the child did not run where it would have by default. */
	readonly note?: string;
}

export interface RecoveryResult {
	readonly recovered: readonly string[];
	readonly failures: readonly { readonly childId: string; readonly reason: string }[];
}

function failure(
	operation: string,
	reason: string,
	childId?: string,
	state?: SubagentState,
	sideEffects: readonly string[] = [],
	safeToRetry = true,
): OperationError {
	return {
		operation,
		...(childId === undefined ? {} : { childId }),
		reason,
		sideEffects,
		...(state === undefined ? {} : { state }),
		safeToRetry,
	};
}

function publicChild(record: SubagentRecord, live: boolean): PublicSubagent {
	return {
		id: record.subagentId,
		agent: record.launchConfig.agent.name,
		...(record.launchConfig.agent.displayName === undefined
			? {}
			: { displayName: record.launchConfig.agent.displayName }),
		state: record.state,
		presentation: record.presentation,
		cwd: record.cwd,
		sessionId: record.sessionId,
		...(record.latestSummary === undefined ? {} : { summary: record.latestSummary }),
		...(record.usage === undefined ? {} : { usage: record.usage }),
		...(record.interrupted === undefined ? {} : { interrupted: record.interrupted }),
		freshness: live ? "live" : "last_known",
		interactive: record.launchConfig.interactive,
		model: record.launchConfig.model,
		thinking: record.launchConfig.thinking,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Operation deadline exceeded (${timeoutMs}ms)`)),
			timeoutMs,
		);
		void operation.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function sessionContainsUserInput(entries: readonly unknown[], expected: string): boolean {
	return entries.some((entry) => {
		const value = isRecord(entry) ? entry : undefined;
		const message = isRecord(value?.message) ? value.message : undefined;
		if (message?.role !== "user") return false;
		if (typeof message.content === "string") return message.content === expected;
		if (!Array.isArray(message.content)) return false;
		const text = message.content
			.map((part) => {
				const content = isRecord(part) ? part : undefined;
				return content?.type === "text" && typeof content.text === "string" ? content.text : "";
			})
			.join("");
		return text === expected;
	});
}

/**
 * Extracts the trailing text of the most recent assistant message in session entries.
 * Used to automatically capture a subagent's final output without requiring a tool call.
 */
export function extractLastAssistantText(entries: readonly unknown[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = isRecord(entry) && isRecord(entry.message) ? entry.message : undefined;
		if (message?.role !== "assistant") continue;
		if (typeof message.content === "string") {
			const text = message.content.trim();
			if (text !== "") return text;
		} else if (Array.isArray(message.content)) {
			const text = message.content
				.filter(
					(p): p is { type: "text"; text: string } =>
						isRecord(p) && p.type === "text" && typeof p.text === "string",
				)
				.map((p) => p.text)
				.join("\n")
				.trim();
			if (text !== "") return text;
		}
	}
	return undefined;
}

export class SubagentManager {
	readonly #deps: ManagerDependencies;
	readonly #chains = new Map<string, Promise<unknown>>();
	readonly #processes = new Map<string, ChildRuntime>();
	/** Panels this process opened. A panel child's process is held by the host, not by us. */
	readonly #attachments = new Map<string, HostAttachment>();
	/**
	 * Children whose process moved to another session. The connection may still be up, but that
	 * process is not this child's runtime any more, so it is neither live nor ours to close.
	 */
	readonly #leftSessions = new Set<string>();
	/**
	 * Children whose runtime this process never saw: a panel child outlives a parent restart, so a
	 * record that still names a runtime after recovery did not reconnect may be running right now.
	 * Nothing here can observe it and one session never gets two writers, so the next send refuses
	 * until an explicit stop clears the record.
	 */
	readonly #unresolvedRuntimes = new Set<string>();
	/** Bumped by every inbound bridge signal, so a reclaim in flight can tell the child moved. */
	readonly #activity = new Map<string, number>();
	readonly #projectors = new Map<string, StateProjector>();
	/** Known child work in flight, separate from failures recorded before Pi finally settles. */
	readonly #working = new Set<string>();
	/** A settled event from an older run cannot clear a newer synchronous start signal. */
	readonly #workVersions = new Map<string, number>();
	readonly #idleTimers = new Map<string, NodeJS.Timeout>();
	readonly #autoReportTimers = new Map<string, NodeJS.Timeout>();
	readonly #failedPanelCloseTimers = new Map<string, NodeJS.Timeout>();
	readonly #lastDeliveredTurn = new Map<string, string>();
	readonly #stopping = new Set<string>();
	readonly #listeners = new Set<() => void>();
	readonly #childEventListeners = new Set<(childId: string, event: unknown) => void>();
	readonly #unsubscribe: Array<() => void> = [];
	#taskRegistry: TaskRegistry | undefined;

	public bindTaskRegistry(registry: TaskRegistry): () => void {
		this.#taskRegistry = registry;
		return () => {
			if (this.#taskRegistry === registry) {
				this.#taskRegistry = undefined;
			}
		};
	}

	public constructor(deps: ManagerDependencies) {
		this.#deps = deps;
		// The manager owns the transport's two inbound streams: child events and connection
		// transitions are what keep a record in step with a child that is running somewhere else.
		this.#unsubscribe.push(
			deps.bridge.onEvent((childId, event) => this.handleEvent(childId, event)),
		);
		this.#unsubscribe.push(
			deps.bridge.onConnectionChange((childId, connected) =>
				this.handleConnectionChange(childId, connected),
			),
		);
	}

	/**
	 * Observes the raw bridge events of every child. A Task producer needs the child's
	 * `task_result` and settle events without also owning the bridge connection.
	 */
	public onChildEvent(listener: (childId: string, event: unknown) => void): () => void {
		this.#childEventListeners.add(listener);
		return () => {
			this.#childEventListeners.delete(listener);
		};
	}

	/** Presentation-only: widget and similar projections re-read list() after this. */
	public onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	public dispose(): void {
		for (const timer of this.#idleTimers.values()) {
			clearTimeout(timer);
		}
		this.#idleTimers.clear();
		for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
	}

	/**
	 * Releases this process's local view of its children. Child processes are deliberately left
	 * alone: a background child is held by its stdin pipe, so it ends when this Pi process ends and
	 * not when extensions are reloaded.
	 */
	public closeLocalConnections(): void {
		this.dispose();
		for (const timer of this.#failedPanelCloseTimers.values()) clearTimeout(timer);
		this.#failedPanelCloseTimers.clear();
		this.#processes.clear();
		this.#attachments.clear();
		this.#leftSessions.clear();
		this.#unresolvedRuntimes.clear();
		this.#activity.clear();
		this.#projectors.clear();
		this.#working.clear();
		this.#workVersions.clear();
		this.#notify();
	}

	/**
	 * Starts the child's runtime where its frozen presentation says. A panel child is owned by the
	 * host, so this process keeps only the attachment handle; a background child is ours to kill.
	 */
	async #start(record: SubagentRecord): Promise<void> {
		// Whatever this child was doing before, a fresh runtime now serves the delegated session.
		this.#leftSessions.delete(record.subagentId);
		if (record.presentation === "panel") {
			const openPanel = this.#deps.presentation?.openPanel;
			if (openPanel === undefined) {
				throw new Error("This parent has no presentation host for a panel child");
			}
			const launch = await openPanel(record);
			if (launch.handle !== undefined) this.#attachments.set(record.subagentId, launch.handle);
			// A panel that could not be opened may still exist and still own the child's session, and
			// nothing here can observe it: the child stays unavailable until an explicit stop.
			if (launch.unconfirmed === true) this.#unresolvedRuntimes.add(record.subagentId);
			if (launch.failure !== undefined) throw new Error(launch.failure);
			return;
		}
		const launch = await this.#deps.launch(record);
		if (launch.handle !== undefined) this.#watchRuntime(record.subagentId, launch.handle);
		if (launch.failure !== undefined) throw new Error(launch.failure);
	}

	/**
	 * Keeps a background child's process handle, and treats its exit as the end of its runtime: the
	 * bridge may already be gone by then (a child that disposes its client before exiting would
	 * otherwise stay "running" forever, with a handle nobody ever releases).
	 */
	#watchRuntime(id: string, runtime: ChildRuntime): void {
		this.#processes.set(id, runtime);
		void runtime.exited.then(() => {
			void this.#mutate(id, () => this.#runtimeEnded(id)).catch((error: unknown) => {
				diagnose(`failed to settle child ${id} after exit: ${errorMessage(error)}`);
			});
		});
	}

	/**
	 * The child's runtime is gone: release what it left behind and say so on the record. Called from
	 * both exits a runtime can take — the process ending, and the bridge connection dropping — so the
	 * order they happen in does not matter.
	 */
	async #runtimeEnded(id: string): Promise<void> {
		const runtime = this.#processes.get(id);
		// A process that is still running is not an ended runtime: the bridge may be reconnecting.
		if (runtime?.alive === true) return;
		if (runtime !== undefined) this.#processes.delete(id);
		if (this.#deps.bridge.isConnected(id)) return;
		this.#working.delete(id);
		await this.#releasePanel(id);
		this.#clearIdleHibernate(id);
		this.#projectors.delete(id);
		const record = await this.#update(id, (current) => {
			if (current.intent === "stopped") return current;
			if (current.state !== "running") return current;
			return {
				...current,
				state: "idle",
				interrupted:
					current.presentation === "panel"
						? "The child bridge disconnected; its panel process exit is not confirmed"
						: "The child runtime ended while a turn was in flight; the session is unchanged and a send resumes it",
			};
		});
		if (record.interrupted !== undefined && record.intent !== "stopped") {
			this.#scheduleAutoReport(id, record);
		}
		if (
			record.presentation === "panel" &&
			record.intent === "active" &&
			record.state !== "done" &&
			record.state !== "blocked" &&
			record.runtime !== undefined &&
			!this.#attachments.has(id)
		) {
			// An adopted child has no host handle: losing its bridge cannot prove its exit.
			this.#unresolvedRuntimes.add(id);
		}
	}

	/** True when a runtime for this child was started here and may still own its session. */
	#runtimeStarted(id: string): boolean {
		return this.#isLive(id) || this.#processes.has(id) || this.#attachments.has(id);
	}

	/**
	 * Says why this child cannot take input while a runtime may still own its session: one this
	 * process holds, one a host panel may still be running, or one the record names that never
	 * reconnected after a parent restart. Only an explicit stop clears that doubt.
	 */
	async #runtimeDoubt(id: string): Promise<string | undefined> {
		if (this.#attachments.has(id)) {
			// A panel the host confirms is gone stops holding this child — the handle it left behind is
			// also what a retried stop would act on, so it is released here before refusing.
			await this.#releasePanel(id).catch(() => undefined);
			if ((await this.#deps.registry.get(id))?.intent === "stopped") {
				return STOPPED_SEND_REASON;
			}
		}
		if (this.#runtimeStarted(id)) {
			return "This child's previous runtime is not confirmed gone (its process or panel may still be running); stop the child to end it, then spawn a new one for this work";
		}
		if (this.#unresolvedRuntimes.has(id)) {
			return "This child's panel runtime is disconnected and its exit cannot be confirmed; no replacement was started. Close any remaining panel, stop the child, then spawn a new child for this work";
		}
		return undefined;
	}

	/** Counts an inbound bridge signal, whether or not its handling is queued behind another task. */
	#bumpActivity(id: string): void {
		this.#activity.set(id, (this.#activity.get(id) ?? 0) + 1);
		this.#clearAutoReport(id);
		this.#clearFailedPanelClose(id);
	}

	/**
	 * Releases a panel whose child has gone away, without being asked to. Only a panel the host
	 * confirms is no longer running its child is closed: a live process behind a missing bridge may
	 * be serving the session the human switched to, and nobody asked for that panel to be ended. A
	 * panel that stays keeps its handle, so an explicit stop can still close it.
	 */
	async #releasePanel(id: string): Promise<void> {
		const attachment = this.#attachments.get(id);
		if (attachment === undefined) return;
		const observed = await attachment.observe();
		if (!(observed.known && !observed.alive)) return;
		let retired: string | undefined;
		const record = await this.#update(id, (current) => {
			if (current.intent === "stopped") return current;
			retired = current.runtime?.runtimeIdentity;
			const { runtime: _runtime, ...withoutRuntime } = current;
			if (current.state === "idle" || current.state === "done") {
				return {
					...withoutRuntime,
					state: "done",
				};
			}
			return {
				...withoutRuntime,
				intent: "stopped",
				state: "stopped",
				interrupted: "The child panel was closed while running; spawn a new child for more work",
			};
		});
		if (retired !== undefined) this.#deps.tokens?.forget(retired);
		const projector = this.#projectors.get(id);
		if (record.state === "done" && projector !== undefined) {
			projector.syncState("done");
		}
		if (record.intent === "stopped") {
			this.#clearIdleHibernate(id);
			this.#projectors.delete(id);
			this.#unresolvedRuntimes.delete(id);
		}
		this.#attachments.delete(id);
		try {
			const cleanup = await attachment.cleanup();
			if (cleanup.exitCode !== 0) {
				diagnose(
					`could not close the leftover ${attachment.identity.host} panel of child ${id}: ${cleanup.stderr}`,
				);
			}
		} catch (error) {
			diagnose(
				`could not close the leftover ${attachment.identity.host} panel of child ${id}: ${errorMessage(error)}`,
			);
		}
	}

	/** Waits for a child's bridge connection to end; false when it is still connected after the wait. */
	#awaitDisconnect(id: string, timeoutMs: number): Promise<boolean> {
		if (!this.#deps.bridge.isConnected(id)) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			let unsubscribe: () => void = () => {};
			const timer = setTimeout(() => {
				unsubscribe();
				resolve(false);
			}, timeoutMs);
			unsubscribe = this.#deps.bridge.onConnectionChange((childId, connected) => {
				if (childId !== id || connected) return;
				clearTimeout(timer);
				unsubscribe();
				resolve(true);
			});
		});
	}

	/**
	 * Arms the idle countdown for a child whose runtime this process can actually reclaim. A child
	 * this process does not own (one adopted after a parent restart) and a host that cannot report
	 * focus (cmux) never get a timer: neither the exit nor the focus could be judged, and a panel is
	 * only ever closed on a judgement, never on a guess.
	 */
	#scheduleIdleHibernate(id: string): void {
		const attachment = this.#attachments.get(id);
		if (attachment === undefined && this.#processes.get(id) === undefined) return;
		if (attachment !== undefined && !attachment.reportsFocus) return;
		this.#clearIdleHibernate(id);
		const timer = setTimeout(() => {
			this.#idleTimers.delete(id);
			void this.#hibernate(id).catch((error) => {
				diagnose(`failed to hibernate idle child ${id}: ${errorMessage(error)}`);
			});
		}, this.#deps.idleTimeoutMs ?? SUBAGENT_IDLE_TIMEOUT_MS);
		timer.unref?.();
		this.#idleTimers.set(id, timer);
	}

	#clearIdleHibernate(id: string): void {
		const timer = this.#idleTimers.get(id);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.#idleTimers.delete(id);
		}
	}

	#scheduleAutoReport(id: string, record: SubagentRecord): void {
		this.#clearAutoReport(id);
		const timer = setTimeout(() => {
			this.#autoReportTimers.delete(id);
			void this.#performAutoReport(id, record);
		}, 5_000);
		timer.unref?.();
		this.#autoReportTimers.set(id, timer);
	}

	#clearAutoReport(id: string): void {
		const timer = this.#autoReportTimers.get(id);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.#autoReportTimers.delete(id);
		}
	}

	#scheduleFailedPanelClose(id: string): void {
		const attachment = this.#attachments.get(id);
		if (attachment === undefined) return;
		this.#clearFailedPanelClose(id);
		const timeoutMs = this.#deps.failedPanelCloseTimeoutMs ?? 15_000;
		const timer = setTimeout(() => {
			this.#failedPanelCloseTimers.delete(id);
			void this.#closeFailedPanel(id).catch((error) => {
				diagnose(`failed to close failed panel for child ${id}: ${errorMessage(error)}`);
			});
		}, timeoutMs);
		timer.unref?.();
		this.#failedPanelCloseTimers.set(id, timer);
	}

	#clearFailedPanelClose(id: string): void {
		const timer = this.#failedPanelCloseTimers.get(id);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.#failedPanelCloseTimers.delete(id);
		}
	}

	async #closeFailedPanel(id: string): Promise<void> {
		const attachment = this.#attachments.get(id);
		if (attachment === undefined) return;
		const record = await this.#deps.registry.get(id);
		if (record === undefined || record.state === "running" || record.intent === "stopped") {
			return;
		}
		if (this.#deps.bridge.isConnected(id)) {
			await this.#request(id, "shutdown").catch(() => undefined);
			this.#deps.bridge.disconnect(id);
		}
		const runtime = this.#processes.get(id);
		if (runtime !== undefined) {
			await runtime.terminate().catch(() => undefined);
			this.#processes.delete(id);
		}
		try {
			await attachment.cleanup();
		} catch (error) {
			diagnose(`failed to cleanup panel for failed child ${id}: ${errorMessage(error)}`);
		}
		this.#attachments.delete(id);
		this.#unresolvedRuntimes.delete(id);
		await this.#update(id, (current) => {
			if (current.intent === "stopped") return current;
			const { runtime: _runtime, ...withoutRuntime } = current;
			return withoutRuntime;
		});
	}

	async #performAutoReport(id: string, _record: SubagentRecord): Promise<void> {
		if (this.#working.has(id)) return;
		const record = (await this.#deps.registry.get(id)) ?? _record;
		if (record.intent === "stopped" || record.state === "running" || record.state === "starting")
			return;

		const entries = await this.#entries(id);
		const text = entries !== undefined ? extractLastAssistantText(entries) : undefined;

		const hasError =
			record.state === "failed" ||
			(record.interrupted !== undefined && record.interrupted.trim() !== "");

		const isBlocked = hasError;

		if (!isBlocked && (text === undefined || text.trim() === "")) {
			const projector = this.#projectors.get(id);
			if (projector !== undefined) {
				projector.syncState("done");
			}
			await this.#update(id, (current) => {
				const { interrupted: _interrupted, ...clean } = current;
				return {
					...clean,
					state: "done",
				};
			});
			if (this.#taskRegistry !== undefined) {
				this.#taskRegistry.settle(id, {
					status: "completed",
					output: "",
					truncated: false,
				});
			}
			return;
		}

		let message: string;
		if (isBlocked) {
			if (record.interrupted !== undefined && record.interrupted.trim() !== "") {
				message =
					text !== undefined && text.trim() !== ""
						? `${record.interrupted}\n\n${text}`
						: record.interrupted;
			} else if (text !== undefined && text.trim() !== "") {
				message = text;
			} else {
				message = "Subagent became idle without completing its task (interrupted or failed).";
			}
		} else {
			message = text ?? "";
		}

		if (this.#lastDeliveredTurn.get(id) === message) return;
		this.#lastDeliveredTurn.set(id, message);

		const reason = isBlocked ? "blocked" : "success";
		const taskStatus = isBlocked ? "failed" : "completed";

		const projector = this.#projectors.get(id);
		if (!isBlocked) {
			if (projector !== undefined) {
				projector.syncState("done");
			}
			await this.#update(id, (current) => {
				const { interrupted: _interrupted, ...clean } = current;
				return {
					...clean,
					state: "done",
				};
			});
		} else {
			if (projector !== undefined) {
				projector.syncState("failed");
			}
			await this.#update(id, (current) => ({
				...current,
				state: "failed",
				interrupted: current.interrupted ?? message,
			}));
		}
		if (this.#taskRegistry !== undefined) {
			this.#taskRegistry.settle(id, {
				status: taskStatus,
				output: message,
				truncated: false,
			});
		}
		if (this.#deps.channel !== undefined) {
			await this.contactParent(id, reason, message);
		}
	}

	/** Reads a child's session entries; exposed for Task completion inspection. */
	public async getEntries(id: string): Promise<readonly unknown[] | undefined> {
		return this.#entries(id);
	}

	/** A child is live while its bridge connection is up, or while a process we started still runs. */
	#isLive(id: string): boolean {
		// A process that left the delegated session is not this child's runtime, however healthy its
		// connection looks: sending to it would drive the session the human switched to.
		if (this.#leftSessions.has(id)) return false;
		if (this.#deps.bridge.isConnected(id)) return true;
		return this.#processes.get(id)?.alive === true;
	}

	/**
	 * True only when the host positively reports the panel is gone. An unobservable panel is not a
	 * closed one, and treating it as closed is what would let a second runtime start for a session
	 * whose first process may still be running.
	 */
	async #panelGone(attachment: HostAttachment | undefined): Promise<boolean> {
		if (attachment === undefined) return true;
		const observed = await attachment.observe();
		return observed.known && !observed.alive;
	}

	/**
	 * Resolves where the child's session lives now: a child that finished while
	 * the parent was busy may have been flushed after its record was written.
	 *
	 * Discovery is not an existence test. A record that was only ever known by session
	 * id would otherwise turn an unreadable session directory into "the session does not
	 * exist", and the next resume would let Pi mint a new session under the same id and
	 * silently drop the child's context. A failure is therefore reported to the caller.
	 */
	async #currentPlacement(record: SubagentRecord): Promise<{
		readonly sessionPath: string | undefined;
		readonly persistence: SubagentRecord["persistence"];
	}> {
		let placement: Awaited<ReturnType<typeof planSessionPlacement>>;
		try {
			placement = await planSessionPlacement({
				sessionId: record.sessionId,
				cwd: record.cwd,
				sessionDir: record.launchConfig.sessionDir,
				persistence: record.persistence,
				...(record.sessionPath === undefined ? {} : { sessionPath: record.sessionPath }),
			});
		} catch (error) {
			throw new Error(
				`Session placement for child ${record.subagentId} could not be verified: ${errorMessage(error)}`,
				{ cause: error },
			);
		}
		if (placement.persistence === "flushed" && placement.sessionPath !== undefined) {
			return { sessionPath: placement.sessionPath, persistence: "flushed" };
		}
		return { sessionPath: record.sessionPath, persistence: record.persistence };
	}

	/** Reads a child's session entries over the bridge, falling back to disk when disconnected. */
	async #entries(id: string): Promise<readonly unknown[] | undefined> {
		if (this.#deps.bridge.isConnected(id)) {
			const response = await this.#request(id, "get_entries").catch(() => undefined);
			if (isRecord(response) && Array.isArray(response.entries) && response.entries.length > 0) {
				return response.entries;
			}
		}
		const record = await this.#deps.registry.get(id).catch(() => undefined);
		if (record !== undefined) {
			const sessionPath =
				record.sessionPath ??
				(await findSessionFile(record.launchConfig.sessionDir, record.sessionId));
			if (sessionPath !== undefined) {
				try {
					const diskEntries = await readSessionJsonlEntries(sessionPath);
					if (diskEntries.length > 0) return diskEntries;
				} catch {
					// return undefined below
				}
			}
		}
		return undefined;
	}

	#request(id: string, operation: BridgeOperation, payload?: unknown): Promise<unknown> {
		return withDeadline(
			this.#deps.bridge.request(id, operation, payload),
			this.#deps.deadlineMs ?? 30_000,
		);
	}

	/**
	 * Ends an idle child's runtime and keeps its identity. The process is what is reclaimed: the
	 * session, the cwd and the launch snapshot stay recorded, so a later send starts the same child
	 * again instead of replaying anything it was interrupted in.
	 */
	async #hibernate(id: string): Promise<void> {
		await this.#mutate(id, async () => {
			const record = await this.#deps.registry.get(id);
			if (
				record === undefined ||
				(record.state !== "idle" && record.state !== "done") ||
				record.intent === "stopped"
			) {
				return;
			}
			const runtime = this.#processes.get(id);
			const attachment = this.#attachments.get(id);
			if (!this.#isLive(id)) return;
			// Signals that arrive while the panel is being checked are queued behind this task, so this
			// count is what tells the reclaim that the child moved after it looked: someone who started
			// using the child must not lose its panel to a decision already in flight.
			const activity = this.#activity.get(id) ?? 0;
			if (attachment !== undefined) {
				// A panel with a human in front of it is not idle, however long ago its last turn ended:
				// the countdown restarts instead of closing the panel under the user.
				const observed = await attachment.observe();
				if (observed.known && !observed.alive) {
					// It had already exited before our shutdown: this is not automatic idle reclaim.
					await this.#releasePanel(id);
					return;
				}
				if (!observed.known || observed.focused !== false) {
					this.#scheduleIdleHibernate(id);
					return;
				}
			}
			if ((this.#activity.get(id) ?? 0) !== activity) {
				this.#scheduleIdleHibernate(id);
				return;
			}
			let shutdownFailure: string | undefined;
			if (this.#deps.bridge.isConnected(id)) {
				await this.#request(id, "shutdown").catch((error: unknown) => {
					shutdownFailure = errorMessage(error);
				});
			}
			if (runtime !== undefined) await runtime.terminate();
			if (attachment !== undefined) await attachment.cleanup();
			const exited =
				(runtime === undefined || !runtime.alive) && (await this.#panelGone(attachment));
			// The handles are kept while the exit is unconfirmed: they are what stops the next send
			// from starting a second runtime, and what a retried stop can act on.
			if (exited) {
				this.#processes.delete(id);
				this.#attachments.delete(id);
			}
			this.#projectors.delete(id);
			await this.#update(id, (current) => {
				if ((current.state !== "idle" && current.state !== "done") || current.intent === "stopped")
					return current;
				if (!exited) {
					// The runtime may still be alive, so hibernating would let the next send start a
					// second execution against a session this one still owns.
					return {
						...current,
						state: "failed",
						interrupted: `Runtime exit is unconfirmed${shutdownFailure === undefined ? "" : ` (${shutdownFailure})`}; the recorded runtime was kept and the child stays unavailable until it is gone`,
					};
				}
				const { runtime: _runtime, ...withoutRuntime } = current;
				return { ...withoutRuntime, state: "done" };
			});
		});
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (error) {
				diagnose(`onChange listener failed: ${errorMessage(error)}`);
			}
		}
	}

	/**
	 * Adopts the children that are still running. Nothing is launched here: a child that survived a
	 * parent restart reconnects its bridge by itself, and a child that did not is simply not live
	 * until a later send starts it from its recorded session.
	 */
	public async recover(): Promise<RecoveryResult> {
		const records = (await this.#deps.registry.list()).filter(
			(record) =>
				record.intent === "active" && record.state !== "done" && record.state !== "stopped",
		);
		const outcomes = await Promise.all(
			records.map(async (record) => {
				if (record.state === "starting" || record.state === "running") {
					this.#working.add(record.subagentId);
				}
				if (!this.#projectors.has(record.subagentId)) {
					this.#projectors.set(record.subagentId, createStateProjector(record.state));
				}
				try {
					if (!(await this.#deps.connect(record))) {
						await this.#settleUnrecovered(record);
						return undefined;
					}
					// The runtime this record names answered, so the doubt about it is gone.
					this.#unresolvedRuntimes.delete(record.subagentId);
					await this.#adopt(record.subagentId);
					return { childId: record.subagentId };
				} catch (error) {
					return { childId: record.subagentId, reason: errorMessage(error) };
				}
			}),
		);
		const settled = outcomes.filter(
			(outcome): outcome is { childId: string } | { childId: string; reason: string } =>
				outcome !== undefined,
		);
		this.#notify();
		return {
			recovered: settled
				.filter((outcome) => !("reason" in outcome))
				.map((outcome) => outcome.childId),
			failures: settled.filter(
				(outcome): outcome is { childId: string; reason: string } => "reason" in outcome,
			),
		};
	}

	/**
	 * A record that names a runtime which did not reconnect. A background child is held by its
	 * parent's stdin pipe, so it died with the parent and that evidence is stale; a panel child is
	 * held by the host and may still be running, so nothing here may start a second runtime for the
	 * same session until the user stops it.
	 */
	async #settleUnrecovered(record: SubagentRecord): Promise<void> {
		this.#working.delete(record.subagentId);
		const retired = record.runtime;
		if (retired === undefined) return;
		if (record.presentation === "panel") {
			this.#unresolvedRuntimes.add(record.subagentId);
			return;
		}
		await this.#update(record.subagentId, (current) => {
			const { runtime: _runtime, ...rest } = current;
			return {
				...rest,
				...(current.state === "running" ? { state: "idle" as const } : {}),
				interrupted:
					"The child runtime ended with the parent process; a later send starts it again from the same session",
			};
		});
		this.#deps.tokens?.forget(retired.runtimeIdentity);
	}

	/** Reads a connected child's real state and puts the record back in step with it. */
	async #adopt(id: string): Promise<void> {
		const workVersion = this.#workVersions.get(id) ?? 0;
		const projector = this.#projectors.get(id);
		const record = await this.#deps.registry.get(id);
		if (projector === undefined || record === undefined) return;
		const entries = await this.#entries(id);
		if (entries !== undefined) projector.rebuild(entries);
		const state = await this.#request(id, "get_state");
		if (
			!isRecord(state) ||
			typeof state.idle !== "boolean" ||
			typeof state.pendingMessages !== "boolean"
		) {
			throw new BridgeError("invalid_state", `Child ${id} did not confirm its current work state`);
		}
		const idle = state.idle && !state.pendingMessages;
		if ((this.#workVersions.get(id) ?? 0) === workVersion) {
			if (idle) this.#working.delete(id);
			else this.#working.add(id);
		}
		// The child's own answer decides whether it is working right now; a transcript that recorded a
		// failed turn still outranks it. Without this the projector keeps saying "running" and the
		// next event that carries no state of its own writes that back onto the record.
		if (projector.snapshot().state !== "failed") projector.syncState(idle ? "idle" : "running");
		const snapshot = projector.snapshot();
		const confirmedInput =
			entries !== undefined &&
			record.unacknowledgedInput !== undefined &&
			sessionContainsUserInput(entries, record.unacknowledgedInput)
				? record.unacknowledgedInput
				: undefined;
		await this.#update(
			id,
			(current) => {
				if (current.intent === "stopped") return current;
				const base =
					confirmedInput === undefined
						? current
						: (({ unacknowledgedInput: _input, ...rest }) => rest)(current);
				// A transcript that recorded a failed turn outranks the session's own idleness.
				const failed = snapshot.state === "failed";
				return {
					...base,
					state: failed ? "failed" : idle ? "idle" : "running",
					...(snapshot.summary === undefined ? {} : { latestSummary: snapshot.summary }),
					usage: snapshot.usage,
					...(snapshot.interrupted === undefined ? {} : { interrupted: snapshot.interrupted }),
				};
			},
			workVersion,
		);
	}

	/**
	 * Where this child runs. `auto` means a panel whenever this parent has a host and the background
	 * otherwise, and the fallback travels back in the spawn result so the caller sees that the child
	 * runs headless; only an explicit request for a panel can fail, because nothing else can satisfy
	 * it.
	 */
	#placement(
		input: SpawnSubagentInput,
	): { readonly presentation: Presentation; readonly note?: string } | { readonly reason: string } {
		const requested = input.presentation ?? "auto";
		const panelAvailable = this.#deps.presentation?.openPanel !== undefined;
		if (requested === "panel") {
			return panelAvailable
				? { presentation: "panel" }
				: { reason: "This parent has no presentation host, so the child cannot run in a panel" };
		}
		if (requested === "background" || !panelAvailable) {
			return {
				presentation: "background",
				...(requested === "background"
					? {}
					: {
							note: `No presentation host is available (${this.#deps.presentation?.reason ?? "no host adapter"}), so this child runs in the background`,
						}),
			};
		}
		return { presentation: "panel" };
	}

	public async spawn(input: SpawnSubagentInput): Promise<SpawnResult | OperationError> {
		const cleanTask = stripHindsightContent(input.task).trim();
		if (cleanTask === "") return failure("spawn", "Task must not be empty");

		let childId: string | undefined;
		try {
			const config = await withDeadline(this.#deps.resolve(input), this.#deps.deadlineMs ?? 30_000);
			const cleanTask = stripHindsightContent(input.task);
			const placement = this.#placement(input);
			if ("reason" in placement)
				return failure("spawn", placement.reason, undefined, undefined, [], false);
			const record = await withDeadline(
				this.#deps.bootstrap({
					parentSessionId: this.#deps.parentSessionId,
					task: cleanTask,
					launchConfig: config,
					presentation: placement.presentation,
				}),
				this.#deps.deadlineMs ?? 30_000,
			);
			this.#projectors.set(record.subagentId, createStateProjector(record.state));
			childId = record.subagentId;
			this.#working.add(childId);
			this.#notify();
			await withDeadline(this.#start(record), this.#deps.deadlineMs ?? 30_000);
			try {
				await this.#request(record.subagentId, "prompt", { message: cleanTask });
			} catch (error) {
				let failureState: SubagentState = "starting";
				try {
					await this.#mutateUpdate(record.subagentId, (current) => ({
						...current,
						state: "failed",
						interrupted: "Initial task delivery was not confirmed",
						unacknowledgedInput: cleanTask,
					}));
					failureState = "failed";
				} catch (updateError) {
					diagnose(
						`failed to persist initial delivery uncertainty for ${record.subagentId}: ${errorMessage(updateError)}`,
					);
				}
				return failure(
					"spawn",
					errorMessage(error),
					record.subagentId,
					failureState,
					[
						"registry record persisted",
						"child launched",
						"initial task delivery was not confirmed",
					],
					false,
				);
			}
			await this.#mutateUpdate(record.subagentId, (current) => {
				const { latestSummary: _latestSummary, ...rest } = current;
				return { ...rest, state: "running" };
			});
			if (this.#taskRegistry !== undefined) {
				try {
					this.#taskRegistry.create({
						id: record.subagentId,
						type: "agent",
						purpose: `${input.agent}: ${input.task}`,
						begin: () => ({
							stop: () => {
								void this.stop(record.subagentId);
							},
							describe: () => ({
								output: `Subagent ${record.subagentId} (${input.agent}) is running`,
								truncated: false,
							}),
						}),
					});
				} catch (regError) {
					diagnose(
						`failed to register background task for subagent ${record.subagentId}: ${errorMessage(regError)}`,
					);
				}
			}
			return {
				child: publicChild((await this.#deps.registry.get(record.subagentId)) ?? record, true),
				...(placement.note === undefined ? {} : { note: placement.note }),
			};
		} catch (error) {
			if (
				childId !== undefined &&
				!this.#runtimeStarted(childId) &&
				!this.#unresolvedRuntimes.has(childId)
			) {
				this.#working.delete(childId);
			}
			this.#notify();
			return failure("spawn", errorMessage(error), undefined, undefined, [], true);
		}
	}

	public send(
		id: string,
		rawMessage: string,
		mode: SendMode = "auto",
		signal?: AbortSignal,
	): Promise<OperationError | PublicSubagent> {
		const message = stripHindsightContent(rawMessage);
		this.#clearIdleHibernate(id);
		this.#clearFailedPanelClose(id);
		return this.#mutate(id, async () => {
			const record = await this.#deps.registry.get(id);
			if (record === undefined) return failure("send", "Unknown child", id);
			if (record.intent === "stopped" || record.state === "stopped")
				return failure("send", STOPPED_SEND_REASON, id, record.state, [], false);
			if (record.state === "failed") {
				const doubt = await this.#runtimeDoubt(id);
				return failure(
					"send",
					doubt ??
						`Subagent ${id} encountered an unrecoverable error and cannot continue: ${record.interrupted ?? "fatal error"}. Spawn a new subagent (optionally with forkFrom) to proceed.`,
					id,
					record.state,
					[],
					false,
				);
			}

			let isResumed = false;
			// Deliverability is the bridge connection, minus a process that left the delegated session:
			// input goes to a session, and this process no longer serves this child's session. What is
			// left to decide is whether a runtime of ours may still own it.
			if (this.#leftSessions.has(id) || !this.#deps.bridge.isConnected(id)) {
				const doubt = await this.#runtimeDoubt(id);
				if (doubt !== undefined) {
					// A runtime is still unaccounted for: it may not answer, but it may also still own the
					// delegated session, and one session never gets two writers.
					return failure("send", doubt, id, record.state, ["runtime metadata retained"], false);
				}
				let placement: {
					sessionPath: string | undefined;
					persistence: SubagentRecord["persistence"];
				};
				try {
					placement = await this.#currentPlacement(record);
				} catch (error) {
					// Nothing was launched, so the record is untouched and a later retry is safe.
					return failure("send", errorMessage(error), id, record.state, ["no runtime was started"]);
				}
				const { sessionPath, persistence } = placement;
				const resumedRecord = await this.#update(id, (current) => ({
					...current,
					state: "starting",
					persistence,
					...(sessionPath === undefined ? {} : { sessionPath }),
					launchConfig:
						sessionPath === undefined
							? current.launchConfig
							: { ...current.launchConfig, sessionPath },
				}));
				if (!this.#projectors.has(id)) {
					this.#projectors.set(id, createStateProjector(resumedRecord.state));
				}
				try {
					await withDeadline(this.#start(resumedRecord), this.#deps.deadlineMs ?? 30_000);
					isResumed = true;
				} catch (error) {
					const reason = errorMessage(error);
					// A launch that failed may still have started a process that owns the session, so the
					// two outcomes must not collapse into one retry: while a runtime may exist, refusing is
					// the only safe answer.
					const started = this.#runtimeStarted(id);
					const settled = await this.#update(id, (current) => {
						if (current.state !== "starting") return current;
						if (started) {
							return {
								...current,
								state: "failed",
								interrupted: `Resume failed after the runtime was started (${reason}); the recorded runtime was kept and the child stays unavailable until it is gone`,
							};
						}
						return {
							...current,
							state: record.state,
							interrupted: `Resume failed before a runtime was confirmed started (${reason}); the child session is untouched`,
						};
					});
					return failure(
						"send",
						`Failed to resume subagent: ${reason}`,
						id,
						settled.state,
						started
							? ["starting state persisted", "runtime start unconfirmed"]
							: ["starting state rolled back", "no runtime was confirmed started"],
						!started,
					);
				}
			}

			const state = isResumed ? "starting" : record.state;
			const operation = isResumed
				? "prompt"
				: mode === "auto"
					? state === "running"
						? "steer"
						: "follow_up"
					: mode;
			if (operation === undefined)
				return failure("send", "Cannot infer send mode from unknown state", id, state);
			if (signal?.aborted) return failure("send", "Send was cancelled", id, state);
			this.#clearFailedPanelClose(id);
			const pending = await this.#update(id, (current) => {
				const { interrupted: _interrupted, ...clean } = current;
				return {
					...clean,
					state: "running",
					unacknowledgedInput: message,
				};
			});
			try {
				await this.#request(id, operation, { message });
			} catch (error) {
				return failure(
					"send",
					errorMessage(error),
					id,
					pending.state,
					["input persisted as unacknowledged before dispatch"],
					false,
				);
			}
			return publicChild((await this.#deps.registry.get(id)) ?? record, true);
		});
	}

	public async get(id: string): Promise<PublicSubagent | OperationError> {
		const record = await this.#deps.registry.get(id);
		return record === undefined
			? failure("get", "Unknown child", id)
			: publicChild(record, this.#isLive(id));
	}

	public async list(): Promise<readonly PublicSubagent[]> {
		const records = await this.#deps.registry.list();
		return records.map((record) => publicChild(record, this.#isLive(record.subagentId)));
	}

	/** Child startup and runs count until Pi settles, including post-agent_end continuation. */
	public get activeCount(): number {
		return this.#working.size;
	}

	public stop(id: string): Promise<OperationError | PublicSubagent> {
		this.#clearIdleHibernate(id);
		return this.#mutate(id, async () => {
			if (this.#stopping.has(id)) return this.get(id);
			this.#stopping.add(id);
			this.#clearFailedPanelClose(id);
			let record: SubagentRecord | undefined;
			try {
				record = await this.#deps.registry.get(id);
			} catch (error) {
				this.#stopping.delete(id);
				return failure("stop", errorMessage(error), id, undefined, [], true);
			}
			if (record === undefined) {
				this.#stopping.delete(id);
				return failure("stop", "Unknown child", id);
			}
			let stopped: SubagentRecord;
			try {
				// The intent is written before anything is ended, so an interrupted stop is still a stop.
				stopped = await this.#update(id, (current) => ({
					...current,
					intent: "stopped",
					state: "stopped",
				}));
			} catch (error) {
				this.#stopping.delete(id);
				return failure("stop", errorMessage(error), id, record.state, [], true);
			}
			try {
				if (this.#isLive(id) && this.#deps.bridge.isConnected(id)) {
					await this.#request(id, "shutdown").catch((error: unknown) => {
						diagnose(`child ${id} did not answer shutdown: ${errorMessage(error)}`);
					});
				}
				const runtime = this.#processes.get(id);
				const attachment = this.#attachments.get(id);
				if (runtime !== undefined) {
					await runtime.terminate();
					if (runtime.alive) {
						// The handle is kept so a retried stop can try again instead of losing the process.
						return failure(
							"stop",
							"Child process termination is not confirmed: the process may still be running",
							id,
							"stopped",
							["stopped intent persisted", "runtime metadata retained"],
							true,
						);
					}
					this.#processes.delete(id);
				}
				if (attachment !== undefined) {
					// The host owns a panel child, so ending it means closing the panel and confirming
					// it is gone; the close itself is not the proof. A panel that is still there keeps
					// its handle, so a retry can try the close again instead of falling back to a
					// bridge-only stop.
					const cleanup = await attachment.cleanup();
					if (!(await this.#panelGone(attachment))) {
						return failure(
							"stop",
							`The child's ${attachment.identity.host} panel is not confirmed gone (${cleanup.stderr || "its state could not be observed"}): the child process may still be running`,
							id,
							"stopped",
							["stopped intent persisted", "runtime metadata retained"],
							true,
						);
					}
					this.#attachments.delete(id);
				}
				if (
					runtime === undefined &&
					attachment === undefined &&
					this.#isLive(id) &&
					this.#deps.bridge.isConnected(id)
				) {
					// Nothing of this child's runtime is ours: it was adopted after a parent restart, so
					// the shutdown request above is all this process can do and the bridge is the only
					// evidence that it worked.
					const gone = await this.#awaitDisconnect(id, SUBAGENT_EXIT_WAIT_MS);
					if (!gone) {
						return failure(
							"stop",
							"Child was asked to shut down but its exit is unconfirmed: this process does not own the child's runtime, so close its panel manually",
							id,
							"stopped",
							["stopped intent persisted", "runtime metadata retained"],
							true,
						);
					}
				}
				this.#projectors.delete(id);
				// An explicit stop is the one thing that clears the doubt about a runtime this process
				// never saw, so a later send may start a fresh one.
				this.#unresolvedRuntimes.delete(id);
				this.#activity.delete(id);
				const runtimeIdentity = stopped.runtime?.runtimeIdentity;
				const current = await this.#deps.registry.get(id);
				if (current !== undefined) {
					stopped = await this.#deps.registry.update(id, current.revision, (value) => {
						const { runtime: _runtime, ...withoutRuntime } = value;
						return withoutRuntime;
					});
				}
				if (this.#taskRegistry !== undefined) {
					this.#taskRegistry.settle(id, {
						status: "cancelled",
						output: `Subagent ${id} was stopped`,
						truncated: false,
					});
				}
				if (runtimeIdentity !== undefined) this.#deps.tokens?.forget(runtimeIdentity);
				return publicChild(stopped, false);
			} catch (error) {
				return failure(
					"stop",
					errorMessage(error),
					id,
					"stopped",
					["stopped intent persisted", "runtime termination may be incomplete"],
					true,
				);
			} finally {
				this.#stopping.delete(id);
			}
		});
	}

	public async contactParent(
		id: string,
		reason: string,
		message: string,
	): Promise<OperationError | { readonly delivered: true }> {
		const record = await this.#deps.registry.get(id);
		if (record === undefined) return failure("contact_parent", "Unknown child", id);
		if (this.#deps.channel === undefined)
			return failure("contact_parent", "Parent channel unavailable", id, record.state, [], true);
		try {
			await this.#deps.channel.deliver({
				parentSessionId: record.parentSessionId,
				childId: id,
				agent: record.launchConfig.agent.displayName ?? record.launchConfig.agent.name,
				task: record.initialTask,
				status: record.state,
				reason,
				message,
			});
			if (reason === "blocked") {
				const projector = this.#projectors.get(id);
				if (projector !== undefined) {
					projector.syncState("blocked");
				}
				await this.#update(id, (current) => ({
					...current,
					state: "blocked",
					interrupted: message,
				}));
				if (this.#taskRegistry !== undefined) {
					this.#taskRegistry.settle(id, {
						status: "failed",
						output: message,
						truncated: false,
					});
				}
				this.#scheduleFailedPanelClose(id);
			} else if (reason === "error") {
				const projector = this.#projectors.get(id);
				if (projector !== undefined) {
					projector.syncState("failed");
				}
				await this.#update(id, (current) => ({
					...current,
					intent: "stopped",
					state: "failed",
					interrupted: message,
				}));
				if (this.#taskRegistry !== undefined) {
					this.#taskRegistry.settle(id, {
						status: "failed",
						output: message,
						truncated: false,
					});
				}
				this.#scheduleFailedPanelClose(id);
			}
			return { delivered: true };
		} catch (error) {
			return failure("contact_parent", errorMessage(error), id, record.state, [], true);
		}
	}

	/**
	 * Handles a request a child sent to its parent. The two child-initiated operations are the
	 * child's report channel and its Task result, and both are answered here so the child learns
	 * whether the parent accepted them.
	 */
	public async handleChildRequest(
		childId: string,
		operation: string,
		payload: unknown,
	): Promise<unknown> {
		const record = await this.#deps.registry.get(childId);
		if (record === undefined) throw new BridgeError("unknown_child", `Unknown child ${childId}`);
		if (operation === "contact_parent") {
			if (!isContactReportPayload(payload)) {
				throw new BridgeError("invalid_payload", "contact_parent requires a report payload");
			}
			if (
				payload.parentSessionId !== record.parentSessionId ||
				payload.childId !== childId ||
				payload.runtimeIdentity !== record.runtime?.runtimeIdentity
			) {
				throw new BridgeError("stale_report", "This report does not belong to the current runtime");
			}
			const reason = payload.reason ?? "blocked";
			const delivered = await this.contactParent(childId, reason, payload.message);
			if ("reason" in delivered) throw new BridgeError("delivery_failed", delivered.reason);
			if (reason === "success") {
				const projector = this.#projectors.get(childId);
				if (projector !== undefined) {
					projector.syncState("done");
				}
				await this.#update(childId, (current) => ({
					...current,
					state: "done",
				}));
			} else if (reason === "blocked") {
				const projector = this.#projectors.get(childId);
				if (projector !== undefined) {
					projector.syncState("blocked");
				}
				await this.#update(childId, (current) => ({
					...current,
					state: "blocked",
				}));
			} else {
				const projector = this.#projectors.get(childId);
				if (projector !== undefined) {
					projector.syncState("failed");
				}
				await this.#update(childId, (current) => ({
					...current,
					intent: "stopped",
					state: "failed",
				}));
			}
			return { delivered: true };
		}
		throw new BridgeError(
			"unsupported_operation",
			`The parent does not accept ${operation} from a child`,
		);
	}

	/** Applies a bridge event to this child's record and notifies the raw child-event listeners. */
	public handleEvent(childId: string, event: unknown): void {
		if (isRecord(event) && event.type === "agent_start") {
			this.#workVersions.set(childId, (this.#workVersions.get(childId) ?? 0) + 1);
			this.#working.add(childId);
			this.#notify();
		}
		// Counted before the per-child queue: an event that arrives while a reclaim is running is
		// queued behind it and could otherwise not cancel a decision already in flight.
		this.#bumpActivity(childId);
		const workVersion = this.#workVersions.get(childId) ?? 0;
		void this.#mutate(childId, () => this.#observe(childId, event, workVersion)).catch(
			(error: unknown) => {
				diagnose(`failed to project event for ${childId}: ${errorMessage(error)}`);
			},
		);
	}

	public handleConnectionChange(childId: string, connected: boolean): void {
		this.#bumpActivity(childId);
		void this.#mutate(childId, async () => {
			const record = await this.#deps.registry.get(childId);
			if (record === undefined) return;
			if (connected) {
				if (record.intent === "stopped") return;
				// A process that left the delegated session is not this child: adopting it would rewrite
				// the child's transcript from the session the human switched to.
				if (this.#leftSessions.has(childId)) return;
				// The runtime this record names is answering, so the doubt about it is gone.
				this.#unresolvedRuntimes.delete(childId);
				if (!this.#projectors.has(childId)) {
					this.#projectors.set(childId, createStateProjector(record.state));
				}
				await this.#adopt(childId);
				return;
			}
			// No bridge any more: the runtime is gone when nothing of it is left here, which is also
			// what releases a panel whose child the host no longer runs.
			await this.#runtimeEnded(childId);
		});
	}

	#dispatch(childId: string, event: unknown): void {
		for (const listener of this.#childEventListeners) {
			try {
				listener(childId, event);
			} catch (error: unknown) {
				diagnose(`child event listener failed for ${childId}: ${errorMessage(error)}`);
			}
		}
	}

	async #observe(id: string, event: unknown, workVersion: number): Promise<void> {
		this.#dispatch(id, event);
		const value = isRecord(event) ? event : undefined;
		if (value === undefined) return;
		if (value.type === "child_lifecycle" && isChildLifecyclePayload(value)) {
			const record = await this.#deps.registry.get(id);
			if (
				record === undefined ||
				record.intent === "stopped" ||
				value.parentSessionId !== record.parentSessionId ||
				value.childId !== id ||
				value.runtimeIdentity !== record.runtime?.runtimeIdentity
			)
				return;
			if (value.kind === "user_interrupt") {
				const message =
					value.message === undefined || value.message === ""
						? "Task is unfinished and waiting for user intent."
						: value.message;
				await this.#update(id, (current) => ({
					...current,
					interrupted: message,
				}));
				await this.contactParent(id, "user_interrupt", message);
				return;
			}
			if (value.kind === "left_session") {
				this.#working.delete(id);
				// The process now serves another session, so it is no longer this child's runtime. Its
				// credential is revoked and its runtime evidence dropped, so neither a reconnect nor a
				// later adopt can mistake the new session for this child; the panel belongs to that other
				// session from now on, which is why it is forgotten here and never closed.
				const retired = record.runtime?.runtimeIdentity;
				this.#clearIdleHibernate(id);
				this.#projectors.delete(id);
				this.#attachments.delete(id);
				this.#leftSessions.add(id);
				this.#unresolvedRuntimes.delete(id);
				// The socket is not this child's channel any more either: leaving it up would let a
				// relaunch mistake the old connection for the new runtime.
				this.#deps.bridge.disconnect(id);
				await this.#update(id, (current) => {
					const { runtime: _runtime, ...withoutRuntime } = current;
					return {
						...withoutRuntime,
						state: "idle",
						interrupted:
							"The child left its session; the surface is no longer controlled by the parent",
					};
				});
				if (retired !== undefined) this.#deps.tokens?.forget(retired);
				return;
			}
			// A child's own quit is a lifecycle notice, not state: the disconnect that follows says
			// whether the runtime is gone.
			return;
		}
		if (value.type === "child_input" && isChildInputPayload(value)) {
			// Someone typed into the panel, so the child is not idle any more. Only human input counts:
			// a message this parent sent over the bridge arrives as `rpc` and says nothing about the
			// panel. The turn that follows re-arms the countdown when it ends with nothing pending.
			if (value.source === "interactive") this.#clearIdleHibernate(id);
			return;
		}
		const record = await this.#deps.registry.get(id);
		if (record === undefined || record.intent === "stopped") return;
		const projector = this.#projectors.get(id);
		if (projector === undefined) return;
		projector.applyEvent(event);
		let confirmedInput: string | undefined;
		if (value.type === "agent_end") {
			// A finished turn is exactly when the session file has the message, so this is where
			// unacknowledged input becomes part of the child's conversation.
			const entries = await this.#entries(id);
			if (entries !== undefined) {
				projector.rebuild(entries);
				if (
					record.unacknowledgedInput !== undefined &&
					sessionContainsUserInput(entries, record.unacknowledgedInput)
				) {
					confirmedInput = record.unacknowledgedInput;
				}
			}
		}
		const current = await this.#deps.registry.get(id);
		if (current === undefined || current.intent === "stopped") return;
		const snapshot = projector.snapshot();
		await this.#update(
			id,
			(entry) => {
				const { interrupted: _prevInterrupted, ...cleanEntry } = entry;
				const base =
					confirmedInput === undefined
						? cleanEntry
						: (({ unacknowledgedInput: _input, ...rest }) => rest)(cleanEntry);
				return {
					...base,
					state: snapshot.state,
					...(snapshot.summary === undefined ? {} : { latestSummary: snapshot.summary }),
					usage: snapshot.usage,
					...(snapshot.interrupted === undefined ? {} : { interrupted: snapshot.interrupted }),
				};
			},
			workVersion,
		);
		if (snapshot.state === "idle") {
			this.#scheduleIdleHibernate(id);
		} else {
			this.#clearIdleHibernate(id);
		}
		if (value.type === "agent_settled" && (this.#workVersions.get(id) ?? 0) === workVersion) {
			this.#working.delete(id);
			this.#notify();
			const latestRecord = (await this.#deps.registry.get(id)) ?? current;
			this.#scheduleAutoReport(id, latestRecord);
		}
	}

	/** Runs an update inside the per-child chain used by the mutating operations. */
	#mutateUpdate(
		id: string,
		updater: (record: SubagentRecord) => SubagentRecord,
	): Promise<SubagentRecord> {
		return this.#mutate(id, () => this.#update(id, updater));
	}

	async #update(
		id: string,
		updater: (record: SubagentRecord) => SubagentRecord,
		workVersion?: number,
	): Promise<SubagentRecord> {
		// The store re-reads the record inside its own write, so an undefined revision cannot
		// lose a concurrent field update and no stale_revision retry is needed.
		const next = await this.#deps.registry.update(id, undefined, updater);
		if (workVersion === undefined || workVersion === (this.#workVersions.get(id) ?? 0)) {
			if (next.state === "starting" || next.state === "running") this.#working.add(id);
			else if (next.state !== "failed") this.#working.delete(id);
		}
		this.#notify();
		return next;
	}

	#mutate<T>(id: string, action: () => Promise<T>): Promise<T> {
		const previous = this.#chains.get(id) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(action);
		this.#chains.set(id, next);
		void next
			.finally(() => {
				if (this.#chains.get(id) === next) this.#chains.delete(id);
			})
			.catch(() => undefined);
		return next;
	}
}
