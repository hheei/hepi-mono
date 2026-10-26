import { readFile } from "node:fs/promises";
import { errorMessage, isRecord } from "@hheei/pi-ext-core";
import { attachRetainedChild, type ChildRuntime } from "./child-process.js";
import type {
	EffectiveLaunchConfig,
	OperationError,
	Presentation,
	PublicSubagent,
	RuntimeAttachment,
	SendMode,
	SpawnSubagentInput,
	SubagentRecord,
	SubagentState,
} from "./domain.js";
import { isOperationError } from "./domain.js";
import type { HostAttachment } from "./host-adapter.js";
import { stripHindsightContent } from "./launch-spec.js";
import type { HostDirectory, LeaseReady } from "./lease.js";
import {
	commitLease,
	createConversationLease,
	RUNTIME_ENDED_RESUME,
	type RuntimeGoneOutcome,
} from "./lease.js";
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

async function readSessionJsonlEntries(filePath: string): Promise<readonly unknown[]> {
	const content = await readFile(filePath, "utf8");
	const entries: unknown[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length > 0) {
			try {
				entries.push(JSON.parse(trimmed));
			} catch {
				// Ignore corrupted line
			}
		}
	}
	return entries;
}

import {
	createStateProjector,
	parseTranscriptFacts,
	type StateProjector,
	type TranscriptFacts,
	transcriptFacts,
} from "./state.js";

/**
 * How long an idle child keeps its runtime. A background child holds a whole Pi process and its
 * session lock, so an idle one is reclaimed after this window and a later `agent_send` starts it
 * again from the same session.
 */
export const SUBAGENT_IDLE_TIMEOUT_MS = 15_000;
export const SUBAGENT_SETTLED_CLOSE_TIMEOUT_MS = 15_000;

/** How long stop waits for an adopted child's bridge to go away before calling the exit unconfirmed. */
export const SUBAGENT_EXIT_WAIT_MS = 2_000;

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
	readonly registry: Pick<SubagentRegistry, "get" | "list" | "update" | "path">;
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
	/**
	 * Host listing used to restore this session's panels before the next turn. Absent in tests that
	 * still exercise the bridge-only recover path.
	 */
	readonly directory?: HostDirectory & {
		rebind?(attachment: RuntimeAttachment): HostAttachment | undefined;
	};
	readonly deadlineMs?: number;
	readonly settledCloseTimeoutMs?: number;
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
	readonly path: string;
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

function acknowledgedPath(response: unknown): string {
	if (
		!isRecord(response) ||
		response.accepted !== true ||
		typeof response.path !== "string" ||
		response.path === ""
	) {
		throw new BridgeError("invalid_state", "Child did not confirm its session path");
	}
	return response.path;
}

function publicChild(
	record: SubagentRecord,
	live: boolean,
	path: string | undefined = record.sessionPath,
): PublicSubagent {
	return {
		id: record.subagentId,
		...(path === undefined ? {} : { path }),
		agent: record.launchConfig.agent.name,
		...(record.launchConfig.agent.displayName === undefined
			? {}
			: { displayName: record.launchConfig.agent.displayName }),
		state: record.state,
		presentation: record.presentation,
		cwd: record.cwd,
		sessionId: record.sessionId,
		...(record.initialTask === undefined ? {} : { task: record.initialTask }),
		...(record.latestSummary === undefined ? {} : { summary: record.latestSummary }),
		...(record.activeTool === undefined ? {} : { activeTool: record.activeTool }),
		...(record.usage === undefined ? {} : { usage: record.usage }),
		...(record.interrupted === undefined ? {} : { interrupted: record.interrupted }),
		freshness: live ? "live" : "last_known",
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
	#ready: Promise<LeaseReady> | undefined;
	/** Panels this process opened. A panel child's process is held by the host, not by us. */
	readonly #attachments = new Map<string, HostAttachment>();
	/**
	 * Children whose process moved to another session. The connection may still be up, but that
	 * process is not this child's runtime any more, so it is neither live nor ours to close.
	 */
	readonly #leftSessions = new Set<string>();
	/** Bumped by every inbound bridge signal, so a reclaim in flight can tell the child moved. */
	readonly #activity = new Map<string, number>();
	readonly #projectors = new Map<string, StateProjector>();
	/** Display paths do not imply that a session has been flushed to disk. */
	readonly #paths = new Map<string, string>();
	/** Known child work in flight, separate from failures recorded before Pi finally settles. */
	readonly #working = new Set<string>();
	/** A settled event from an older run cannot clear a newer synchronous start signal. */
	readonly #workVersions = new Map<string, number>();
	readonly #settledPanelCloseTimers = new Map<string, NodeJS.Timeout>();
	readonly #pendingAutoReports = new Map<string, SubagentRecord>();
	#autoReportBatchTimer: NodeJS.Timeout | undefined;
	readonly #lastDeliveredTurn = new Map<
		string,
		{ readonly workVersion: number; readonly message: string }
	>();
	readonly #stopping = new Set<string>();
	readonly #listeners = new Set<() => void>();
	readonly #unsubscribe: Array<() => void> = [];

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

	/** Presentation-only: status and similar projections re-read list() after this. */
	public onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	public dispose(): void {
		if (this.#autoReportBatchTimer !== undefined) {
			clearTimeout(this.#autoReportBatchTimer);
			this.#autoReportBatchTimer = undefined;
		}
		this.#pendingAutoReports.clear();
		for (const timer of this.#settledPanelCloseTimers.values()) {
			clearTimeout(timer);
		}
		this.#settledPanelCloseTimers.clear();
		for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
	}

	/**
	 * Releases this process's local view of its children. Child processes are deliberately left
	 * alone: a background child is held by its stdin pipe, so it ends when this Pi process ends and
	 * not when extensions are reloaded.
	 */
	public closeLocalConnections(): void {
		this.dispose();
		if (this.#autoReportBatchTimer !== undefined) {
			clearTimeout(this.#autoReportBatchTimer);
			this.#autoReportBatchTimer = undefined;
		}
		this.#pendingAutoReports.clear();
		this.#processes.clear();
		this.#attachments.clear();
		this.#leftSessions.clear();
		this.#activity.clear();
		this.#projectors.clear();
		this.#paths.clear();
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
		// A live process is not over. The lock is the connection: an exit this process already
		// saw is recorded here even when the claim has not dropped yet. A later release is the
		// same end, and only the transition that leaves `running` schedules a report.
		if (runtime?.alive === true) return;
		const sawExit = runtime !== undefined;
		if (sawExit) {
			this.#processes.delete(id);
			if (this.#deps.bridge.isConnected(id)) this.#deps.bridge.disconnect(id);
		}
		if (!sawExit && this.#deps.bridge.isConnected(id)) return;
		this.#working.delete(id);
		await this.#dropDeadPanel(id);
		this.#clearSettledPanelClose(id);
		this.#projectors.delete(id);
		await this.#recordWriterGone(id);
	}

	/** True while a writer this process can see is still there: a held lock, or a process handle. A panel tab is not a writer. */
	#runtimeStarted(id: string): boolean {
		return this.#isLive(id) || this.#processes.has(id);
	}

	/**
	 * A new runtime may not start while a writer this process can see is still there. A connected
	 * bridge is that writer, so input goes to it instead of through here. A leftover tab is not a writer.
	 */
	#runtimeDoubt(id: string): string | undefined {
		if (this.#processes.get(id)?.alive === true) {
			return "This child's process is still running; stop it, then send to this same child";
		}
		return undefined;
	}

	/**
	 * Counts an inbound signal before its handler is queued, so a decision already in flight can see
	 * it. invalidateReport is only for a new turn: compaction, a late update, or the bridge dropping
	 * are not the child starting over, and treating them as such dropped the reply.
	 */
	#bumpActivity(id: string, invalidateReport = true): void {
		this.#activity.set(id, (this.#activity.get(id) ?? 0) + 1);
		if (invalidateReport) this.#clearAutoReport(id);
		this.#clearSettledPanelClose(id);
	}

	/**
	 * Forgets a panel the host already says is gone, and closes that leftover tab. A tab the host
	 * still reports, or cannot see, stays in hand so stop can close it. It does not block a send.
	 */
	async #dropDeadPanel(id: string): Promise<void> {
		const attachment = this.#attachments.get(id);
		if (attachment === undefined) return;
		const observed = await attachment.observe();
		if (!(observed.known && !observed.alive)) return;
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

	/**
	 * The ledger stops naming a writer that is gone. A child that was running becomes blocked, once,
	 * unless its session already ends in a completed reply: that reply is delivered instead. The next
	 * send starts the same session again. Callers that still have a tab close it themselves.
	 */
	async #recordWriterGone(id: string): Promise<void> {
		const current = await this.#deps.registry.get(id);
		if (
			current !== undefined &&
			current.state === "running" &&
			current.intent !== "stopped" &&
			(await this.#finishedReply(id, current.unacknowledgedInput))
		) {
			const released = await this.#releaseRuntime(id, "finished");
			if (released === undefined) return;
			const next = await this.#update(id, (entry) => {
				const { interrupted: _interrupted, ...rest } = entry;
				return { ...rest, state: "done" };
			});
			this.#scheduleAutoReport(id, next);
			return;
		}
		await this.#releaseRuntime(id, "drop");
	}

	/**
	 * True when the session file ends on a completed assistant reply and any send still being
	 * confirmed is already in that file. An unflushed prompt is not a finished turn.
	 */
	async #finishedReply(id: string, expectedInput: string | undefined): Promise<boolean> {
		const entries = await this.#diskEntries(id);
		if (entries === undefined || !persistedReplyFinished(entries)) return false;
		if (expectedInput === undefined) return true;
		return transcriptFacts(entries, expectedInput).containsInput;
	}

	/** Runtime leaves the ledger only through a lease edge. */
	async #releaseRuntime(
		id: string,
		outcome: RuntimeGoneOutcome,
	): Promise<SubagentRecord | undefined> {
		const current = await this.#deps.registry.get(id);
		if (current === undefined) return undefined;
		const identity = current.runtime?.runtimeIdentity;
		const next = await commitLease(this.#deps.registry, id, { type: "runtime-gone", outcome });
		if (identity !== undefined && next.runtime === undefined) this.#deps.tokens?.forget(identity);
		if (
			outcome === "drop" &&
			current.state === "running" &&
			current.intent !== "stopped" &&
			next.state === "blocked"
		) {
			this.#scheduleAutoReport(id, next);
		}
		return next;
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

	#scheduleAutoReport(id: string, record: SubagentRecord): void {
		this.#pendingAutoReports.set(id, record);
		if (this.#autoReportBatchTimer !== undefined) {
			clearTimeout(this.#autoReportBatchTimer);
		}
		// Batch reports: if all children settled, flush in 500ms; otherwise wait up to 10000ms for others
		const delayMs = this.#working.size > 0 ? 10_000 : 500;
		this.#autoReportBatchTimer = setTimeout(async () => {
			this.#autoReportBatchTimer = undefined;
			const batch = [...this.#pendingAutoReports.entries()];
			this.#pendingAutoReports.clear();
			for (const [childId, childRecord] of batch) {
				await this.#performAutoReport(childId, childRecord).catch((error: unknown) => {
					diagnose(`failed to report child ${childId}: ${errorMessage(error)}`);
				});
			}
		}, delayMs);
		this.#autoReportBatchTimer.unref?.();
	}

	#clearAutoReport(id: string): void {
		this.#pendingAutoReports.delete(id);
		if (this.#pendingAutoReports.size === 0 && this.#autoReportBatchTimer !== undefined) {
			clearTimeout(this.#autoReportBatchTimer);
			this.#autoReportBatchTimer = undefined;
		}
	}

	#scheduleSettledPanelClose(id: string): void {
		const attachment = this.#attachments.get(id);
		const runtime = this.#processes.get(id);
		if (attachment === undefined && runtime === undefined) return;
		if (attachment !== undefined && !attachment.reportsFocus) return;
		this.#clearSettledPanelClose(id);
		const timeoutMs =
			this.#deps.settledCloseTimeoutMs ??
			this.#deps.failedPanelCloseTimeoutMs ??
			this.#deps.idleTimeoutMs ??
			SUBAGENT_SETTLED_CLOSE_TIMEOUT_MS;
		const timer = setTimeout(() => {
			this.#settledPanelCloseTimers.delete(id);
			void this.#closeSettledPanel(id).catch((error) => {
				diagnose(`failed to close settled panel for child ${id}: ${errorMessage(error)}`);
			});
		}, timeoutMs);
		timer.unref?.();
		this.#settledPanelCloseTimers.set(id, timer);
	}

	#clearSettledPanelClose(id: string): void {
		const timer = this.#settledPanelCloseTimers.get(id);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.#settledPanelCloseTimers.delete(id);
		}
	}

	async #closeSettledPanel(id: string): Promise<void> {
		await this.#mutate(id, async () => {
			const record = await this.#deps.registry.get(id);
			if (
				record === undefined ||
				record.state === "running" ||
				record.intent === "stopped" ||
				this.#working.has(id)
			) {
				return;
			}
			const attachment = this.#attachments.get(id);
			const runtime = this.#processes.get(id);
			if (attachment === undefined && runtime === undefined) return;
			if (!this.#isLive(id)) return;

			const activity = this.#activity.get(id) ?? 0;
			if (attachment !== undefined) {
				const observed = await attachment.observe();
				if (observed.known && !observed.alive) {
					await this.#dropDeadPanel(id);
					await this.#recordWriterGone(id);
					return;
				}
				if ((this.#activity.get(id) ?? 0) !== activity) {
					this.#scheduleSettledPanelClose(id);
					return;
				}
				if (attachment.reportsFocus && (!observed.known || observed.focused !== false)) {
					this.#scheduleSettledPanelClose(id);
					return;
				}
			}

			if (this.#deps.bridge.isConnected(id)) {
				await this.#request(id, "shutdown").catch(() => undefined);
				this.#deps.bridge.disconnect(id);
			}
			if (runtime !== undefined) {
				await runtime.terminate().catch(() => undefined);
			}
			if (attachment !== undefined) {
				try {
					await attachment.cleanup();
				} catch (error) {
					diagnose(`failed to cleanup panel for child ${id}: ${errorMessage(error)}`);
				}
			}
			const exited =
				(runtime === undefined || !runtime.alive) && (await this.#panelGone(attachment));
			if (exited) {
				if (runtime !== undefined) this.#processes.delete(id);
				if (attachment !== undefined) this.#attachments.delete(id);
				await this.#releaseRuntime(id, "drop");
			}
			// The tab is still there, or the host could not say. Leave it. The caller closes it.
		});
	}

	async #performAutoReport(id: string, _record: SubagentRecord): Promise<void> {
		if (this.#working.has(id)) return;
		const record = (await this.#deps.registry.get(id)) ?? _record;
		if (record.intent === "stopped" || record.state === "running") return;
		const activity = this.#activity.get(id) ?? 0;
		const workVersion = this.#workVersions.get(id) ?? 0;

		const facts = await this.#facts(id);
		const text = facts?.summary;
		await this.#mutate(id, async () => {
			const current = await this.#deps.registry.get(id);
			const activityMoved = (this.#activity.get(id) ?? 0) !== activity;
			const versionMoved = (this.#workVersions.get(id) ?? 0) !== workVersion;
			if (
				current === undefined ||
				current.intent === "stopped" ||
				current.state === "running" ||
				this.#working.has(id) ||
				activityMoved ||
				versionMoved
			) {
				// Still settled: the signal was bookkeeping, not a new turn. Dropping the reply here left
				// the parent silent until the process died and the ledger was still running.
				if (
					current !== undefined &&
					current.intent !== "stopped" &&
					current.state !== "running" &&
					!this.#working.has(id) &&
					(activityMoved || versionMoved)
				) {
					this.#scheduleAutoReport(id, current);
				}
				return;
			}

			const isError = current.state === "error" || record.state === "error";
			const isBlocked =
				!isError &&
				(current.state === "blocked" ||
					record.state === "blocked" ||
					(current.interrupted !== undefined && current.interrupted.trim() !== "") ||
					(record.interrupted !== undefined && record.interrupted.trim() !== ""));
			const failed = isError || isBlocked;

			if (!failed && (text === undefined || text.trim() === "")) {
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
				return;
			}

			let message: string;
			const interruptedText = current.interrupted?.trim() || record.interrupted?.trim();
			if (isError) {
				message = interruptedText || "Subagent failed without error details.";
			} else if (isBlocked) {
				if (interruptedText !== undefined && interruptedText !== "") {
					message =
						text !== undefined && text.trim() !== ""
							? `${interruptedText}\n\n${text}`
							: interruptedText;
				} else if (text !== undefined && text.trim() !== "") {
					message = text;
				} else {
					message = "Subagent became idle without completing its task (interrupted or failed).";
				}
			} else {
				message = text ?? "";
			}

			const reason = isError ? "error" : isBlocked ? "blocked" : "success";
			if (
				reason === "success" &&
				facts?.contextTokens !== undefined &&
				facts.contextTokens >= 100_000
			) {
				const kTokens = `${Math.round(facts.contextTokens / 1000)}k`;
				message = `${message}\n\n[Context: ~${kTokens} tokens. If retaining this subagent for future tasks, send "/compact" via agent_send to trim memory.]`;
			}

			const lastDelivered = this.#lastDeliveredTurn.get(id);
			if (
				lastDelivered !== undefined &&
				lastDelivered.workVersion === workVersion &&
				lastDelivered.message === message
			) {
				return;
			}

			const projector = this.#projectors.get(id);
			const updatedRecord = !failed
				? await this.#update(id, (current) => {
						const { interrupted: _interrupted, ...clean } = current;
						return {
							...clean,
							state: "done",
						};
					})
				: await this.#update(id, (current) => ({
						...current,
						state: isError ? "error" : "blocked",
						interrupted: current.interrupted ?? message,
					}));

			if (projector !== undefined) {
				projector.syncState(isError ? "error" : isBlocked ? "blocked" : "done");
			}
			this.#scheduleSettledPanelClose(id);

			let deliveryOk = true;
			if (this.#deps.channel !== undefined) {
				const contactResult = await this.contactParent(id, reason, message, updatedRecord);
				if (isOperationError(contactResult)) {
					deliveryOk = false;
				}
			}
			if (deliveryOk) {
				this.#lastDeliveredTurn.set(id, { workVersion, message });
			}
		});
	}

	/** Reads a child's session entries; used by transcript inspection fallbacks. */
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

	/** The session file, when the bridge cannot answer. A missing file is not an empty transcript. */
	async #diskEntries(id: string): Promise<readonly unknown[] | undefined> {
		const record = await this.#deps.registry.get(id).catch(() => undefined);
		if (record === undefined) return undefined;
		const sessionPath =
			record.sessionPath ??
			(await findSessionFile(record.launchConfig.sessionDir, record.sessionId));
		if (sessionPath === undefined) return undefined;
		try {
			const diskEntries = await readSessionJsonlEntries(sessionPath);
			return diskEntries.length > 0 ? diskEntries : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Usage, the last assistant text, and whether one input landed. The child computes this
	 * from the session it already has; the transcript is not copied into the mailbox.
	 */
	async #facts(id: string, expectedInput?: string): Promise<TranscriptFacts | undefined> {
		if (this.#deps.bridge.isConnected(id)) {
			const response = await this.#request(
				id,
				"session_facts",
				expectedInput === undefined ? undefined : { expectedInput },
			).catch(() => undefined);
			const facts = parseTranscriptFacts(response);
			if (facts !== undefined) return facts;
		}
		const entries = await this.#diskEntries(id);
		return entries === undefined ? undefined : transcriptFacts(entries, expectedInput);
	}

	/** Reads a child's session entries over the bridge, falling back to disk when disconnected. */
	async #entries(id: string): Promise<readonly unknown[] | undefined> {
		if (this.#deps.bridge.isConnected(id)) {
			const response = await this.#request(id, "get_entries").catch(() => undefined);
			if (isRecord(response) && Array.isArray(response.entries) && response.entries.length > 0) {
				return response.entries;
			}
		}
		return this.#diskEntries(id);
	}

	#request(id: string, operation: BridgeOperation, payload?: unknown): Promise<unknown> {
		return withDeadline(
			this.#deps.bridge.request(id, operation, payload),
			this.#deps.deadlineMs ?? 30_000,
		);
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
			(record) => record.intent === "active" && record.state === "running",
		);
		const outcomes = await Promise.all(
			records.map(async (record) => {
				this.#working.add(record.subagentId);
				if (!this.#projectors.has(record.subagentId)) {
					this.#projectors.set(record.subagentId, createStateProjector(record.state));
				}
				try {
					if (!(await this.#deps.connect(record))) {
						await this.#settleUnrecovered(record);
						return undefined;
					}
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
	 * A record that names a runtime which did not reconnect. A background child died with this
	 * process, because its stdin pipe did. A panel child is the same fact as any other missing
	 * writer: the ledger drops it, and a later send starts the session again.
	 */
	async #settleUnrecovered(record: SubagentRecord): Promise<void> {
		this.#working.delete(record.subagentId);
		this.#projectors.delete(record.subagentId);
		if (record.presentation === "panel") {
			await this.#recordWriterGone(record.subagentId);
			return;
		}
		await this.#releaseRuntime(record.subagentId, "parent-exit");
	}

	/** Reads a connected child's real state and puts the record back in step with it. */
	async #adopt(id: string): Promise<void> {
		const workVersion = this.#workVersions.get(id) ?? 0;
		const projector = this.#projectors.get(id);
		const record = await this.#deps.registry.get(id);
		if (projector === undefined || record === undefined) return;
		const facts = await this.#facts(id, record.unacknowledgedInput);
		if (facts !== undefined) projector.applyTranscriptFacts(facts);
		const state = await this.#request(id, "get_state");
		if (
			!isRecord(state) ||
			typeof state.idle !== "boolean" ||
			typeof state.pendingMessages !== "boolean"
		) {
			throw new BridgeError("invalid_state", `Child ${id} did not confirm its current work state`);
		}
		const idle = state.idle && !state.pendingMessages;
		if (typeof state.path === "string" && state.path !== "") {
			this.#paths.set(id, state.path);
		}
		if ((this.#workVersions.get(id) ?? 0) === workVersion) {
			if (idle) this.#working.delete(id);
			else this.#working.add(id);
		}
		// The child's own answer decides whether it is working right now; a transcript that recorded a
		// failed turn still outranks it. Without this the projector keeps saying "running" and the
		// next event that carries no state of its own writes that back onto the record.
		if (projector.snapshot().state !== "error") projector.syncState(idle ? "done" : "running");
		const snapshot = projector.snapshot();
		const confirmedInput =
			facts?.containsInput && record.unacknowledgedInput !== undefined
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
				const hasError = snapshot.state === "error";
				const { interrupted: _interrupted, ...withoutInterrupted } = base;
				const {
					latestSummary: _summary,
					activeTool: _tool,
					usage: _usage,
					...withoutVolatile
				} = withoutInterrupted;
				return {
					...withoutVolatile,
					state: hasError ? "error" : idle ? "done" : "running",
				};
			},
			workVersion,
		);
		if (snapshot.state === "done" || snapshot.state === "blocked" || snapshot.state === "error") {
			this.#scheduleSettledPanelClose(id);
		} else {
			this.#clearSettledPanelClose(id);
		}
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
			await withDeadline(this.#start(record), this.#deps.deadlineMs ?? 60_000);
			let path: string;
			try {
				path = acknowledgedPath(
					await this.#request(record.subagentId, "prompt", { message: cleanTask }),
				);
				this.#paths.set(record.subagentId, path);
			} catch (error) {
				let failureState: SubagentState = "error";
				try {
					await this.#mutateUpdate(record.subagentId, (current) => ({
						...current,
						state: "error",
						interrupted: "Initial task delivery was not confirmed",
						unacknowledgedInput: cleanTask,
					}));
					failureState = "error";
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
			return {
				child: publicChild(
					(await this.#deps.registry.get(record.subagentId)) ?? record,
					true,
					path,
				),
				path,
				...(placement.note === undefined ? {} : { note: placement.note }),
			};
		} catch (error) {
			if (childId === undefined) return failure("spawn", errorMessage(error));
			const failedId = childId;
			const reason = errorMessage(error);
			const failed = await this.#mutate(failedId, async () => {
				const uncertain = this.#runtimeStarted(failedId);
				if (!this.#isLive(failedId)) this.#working.delete(failedId);
				await this.#update(failedId, (current) => ({
					...current,
					state: "error",
					interrupted: reason,
				}));
				this.#projectors.get(failedId)?.syncState("error");
				return failure(
					"spawn",
					reason,
					failedId,
					"error",
					[
						"registry record persisted",
						...(uncertain ? ["runtime start or cleanup unconfirmed"] : ["no runtime remains"]),
					],
					!uncertain,
				);
			});
			return failed;
		}
	}

	public send(
		id: string,
		rawMessage: string,
		mode: SendMode = "steer",
		signal?: AbortSignal,
	): Promise<OperationError | PublicSubagent> {
		const message = stripHindsightContent(rawMessage);
		this.#bumpActivity(id);
		this.#clearSettledPanelClose(id);
		return this.#mutate(id, async () => {
			const record = await this.#deps.registry.get(id);
			if (record === undefined) return failure("send", "Unknown child", id);
			let isResumed = false;
			// Deliverability is the bridge connection, minus a process that left the delegated session:
			// input goes to a session, and this process no longer serves this child's session. What is
			// left to decide is whether a runtime of ours may still own it.
			if (this.#leftSessions.has(id) || !this.#deps.bridge.isConnected(id)) {
				const doubt = this.#runtimeDoubt(id);
				if (doubt !== undefined) {
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
					state: "running",
					intent: "active",
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
					await withDeadline(this.#start(resumedRecord), this.#deps.deadlineMs ?? 60_000);
					isResumed = true;
				} catch (error) {
					const reason = errorMessage(error);
					// A launch that failed may still have started a process that owns the session, so the
					// two outcomes must not collapse into one retry: while a runtime may exist, refusing is
					// the only safe answer.
					const started = this.#runtimeStarted(id);
					const settled = await this.#update(id, (current) => {
						if (current.state !== "running") return current;
						if (started) {
							return {
								...current,
								state: "error",
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
							? ["running state persisted", "runtime start unconfirmed"]
							: ["running state rolled back", "no runtime was confirmed started"],
						!started,
					);
				}
			}

			const state = isResumed ? "running" : record.state;
			// A resume already starts a fresh run, so the mode has nothing to decide: the message is
			// that run's prompt. Otherwise the caller's mode is the request, with no state guessing:
			// a running child steers at its next model step, an idle one simply starts a run.
			const operation = isResumed ? "prompt" : mode;
			if (signal?.aborted) return failure("send", "Send was cancelled", id, state);
			this.#clearSettledPanelClose(id);
			const pending = await this.#update(id, (current) => {
				const { interrupted: _interrupted, ...clean } = current;
				return {
					...clean,
					state: "running",
					intent: "active",
					unacknowledgedInput: message,
				};
			});
			try {
				const path = acknowledgedPath(await this.#request(id, operation, { message }));
				this.#paths.set(id, path);
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
			return publicChild((await this.#deps.registry.get(id)) ?? pending, true, this.#paths.get(id));
		});
	}

	public async get(id: string): Promise<PublicSubagent | OperationError> {
		const record = await this.#deps.registry.get(id);
		if (record === undefined) return failure("get", "Unknown child", id);
		const live = this.#isLive(id);
		return publicChild(this.#withSnapshot(record), live, this.#paths.get(id));
	}

	public async list(): Promise<readonly PublicSubagent[]> {
		const records = await this.#deps.registry.list();
		return records.map((record) =>
			publicChild(
				this.#withSnapshot(record),
				this.#isLive(record.subagentId),
				this.#paths.get(record.subagentId),
			),
		);
	}

	public stop(id: string): Promise<OperationError | PublicSubagent> {
		this.#clearSettledPanelClose(id);
		return this.#mutate(id, async () => {
			if (this.#stopping.has(id)) return this.get(id);
			this.#stopping.add(id);
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
				stopped = await commitLease(this.#deps.registry, id, { type: "stop-intent" });
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
							"error",
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
						await this.#update(id, (current) => ({ ...current, state: "error" })).catch(
							() => undefined,
						);
						return failure(
							"stop",
							`The child's ${attachment.identity.host} panel is not confirmed gone (${cleanup.stderr || "its state could not be observed"}): the child process may still be running`,
							id,
							"error",
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
							"error",
							["stopped intent persisted", "runtime metadata retained"],
							true,
						);
					}
				}
				this.#projectors.delete(id);
				this.#activity.delete(id);
				const finished = await this.#releaseRuntime(id, "finished");
				if (finished !== undefined) stopped = finished;
				return publicChild(stopped, false);
			} catch (error) {
				return failure(
					"stop",
					errorMessage(error),
					id,
					"error",
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
		knownRecord?: SubagentRecord,
	): Promise<OperationError | { readonly delivered: true }> {
		const record = knownRecord ?? (await this.#deps.registry.get(id));
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
				this.#scheduleSettledPanelClose(id);
			} else if (reason === "error") {
				const projector = this.#projectors.get(id);
				if (projector !== undefined) {
					projector.syncState("error");
				}
				await this.#update(id, (current) => ({
					...current,
					state: "error",
					interrupted: message,
				}));
				this.#scheduleSettledPanelClose(id);
			}
			return { delivered: true };
		} catch (error) {
			return failure("contact_parent", errorMessage(error), id, record.state, [], true);
		}
	}

	/** Answers a request a child sent to its parent, so the child learns whether the parent accepted it. */
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
			const delivered = await this.contactParent(childId, reason, payload.message, record);
			if ("reason" in delivered) throw new BridgeError("delivery_failed", delivered.reason);
			if (reason === "success" || reason === "blocked") {
				const terminalState = reason === "success" ? "done" : "blocked";
				const projector = this.#projectors.get(childId);
				if (projector !== undefined) {
					projector.syncState(terminalState);
				}
				await this.#update(childId, (current) => {
					const { unacknowledgedInput: _input, ...clean } = current;
					return {
						...clean,
						state: terminalState,
					};
				});
				this.#scheduleSettledPanelClose(childId);
			} else {
				const projector = this.#projectors.get(childId);
				if (projector !== undefined) {
					projector.syncState("error");
				}
				await this.#update(childId, (current) => ({
					...current,
					intent: "stopped",
					state: "error",
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
		// queued behind it and could otherwise not cancel a decision already in flight. Only a new
		// turn cancels a reply that is already waiting.
		this.#bumpActivity(childId, isRecord(event) && resumesChildWork(event.type));
		const workVersion = this.#workVersions.get(childId) ?? 0;
		void this.#mutate(childId, () => this.#observe(childId, event, workVersion)).catch(
			(error: unknown) => {
				diagnose(`failed to project event for ${childId}: ${errorMessage(error)}`);
			},
		);
	}

	public handleConnectionChange(childId: string, connected: boolean): void {
		this.#bumpActivity(childId, false);
		void this.#mutate(childId, async () => {
			const record = await this.#deps.registry.get(childId);
			if (record === undefined) return;
			if (connected) {
				if (record.intent === "stopped") return;
				// A process that left the delegated session is not this child: adopting it would rewrite
				// the child's transcript from the session the human switched to.
				if (this.#leftSessions.has(childId)) return;
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

	async #observe(id: string, event: unknown, workVersion: number): Promise<void> {
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
				await this.contactParent(id, "user_interrupt", message, record);
				return;
			}
			if (value.kind === "left_session") {
				this.#working.delete(id);
				// The process now serves another session, so it is no longer this child's runtime. Its
				// credential is revoked and its runtime evidence dropped, so neither a reconnect nor a
				// later adopt can mistake the new session for this child; the panel belongs to that other
				// session from now on, which is why it is forgotten here and never closed.
				const retired = record.runtime?.runtimeIdentity;
				this.#clearSettledPanelClose(id);
				this.#projectors.delete(id);
				this.#attachments.delete(id);
				this.#leftSessions.add(id);
				// The socket is not this child's channel any more either: leaving it up would let a
				// relaunch mistake the old connection for the new runtime.
				this.#deps.bridge.disconnect(id);
				await commitLease(this.#deps.registry, id, { type: "left-session" });
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
			if (value.source === "interactive") this.#clearSettledPanelClose(id);
			return;
		}
		const record = await this.#deps.registry.get(id);
		if (record === undefined || record.intent === "stopped") return;
		const projector = this.#projectors.get(id);
		if (projector === undefined) return;
		projector.applyEvent(event);
		let confirmedInput: string | undefined;
		if (value.type === "turn_end" || value.type === "agent_end") {
			// A finished turn is exactly when the session file has the message, so this is where
			// unacknowledged input becomes part of the child's conversation.
			const facts = await this.#facts(id, record.unacknowledgedInput);
			if (facts !== undefined) {
				projector.applyTranscriptFacts(facts);
				if (record.unacknowledgedInput !== undefined && facts.containsInput) {
					confirmedInput = record.unacknowledgedInput;
				}
			}
		}
		const current = await this.#deps.registry.get(id);
		if (current === undefined || current.intent === "stopped") return;
		const snapshot = projector.snapshot();
		const durable = durableProjection(current, snapshot, confirmedInput !== undefined);
		if (durable !== undefined) {
			await this.#update(
				id,
				(entry) => {
					const {
						interrupted: _prevInterrupted,
						activeTool: _prevActiveTool,
						latestSummary: _prevSummary,
						usage: _prevUsage,
						...cleanEntry
					} = entry;
					const base =
						confirmedInput === undefined
							? cleanEntry
							: (({ unacknowledgedInput: _input, ...rest }) => rest)(cleanEntry);
					return {
						...base,
						state: snapshot.state,
						...(snapshot.interrupted === undefined ? {} : { interrupted: snapshot.interrupted }),
					};
				},
				workVersion,
			);
		} else {
			this.#notify();
		}
		if (snapshot.state === "done" || snapshot.state === "blocked" || snapshot.state === "error") {
			this.#scheduleSettledPanelClose(id);
		} else {
			this.#clearSettledPanelClose(id);
		}
		if (value.type === "agent_settled" && (this.#workVersions.get(id) ?? 0) === workVersion) {
			this.#working.delete(id);
			this.#notify();
			const latestRecord = (await this.#deps.registry.get(id)) ?? current;
			this.#scheduleAutoReport(id, latestRecord);
		}
	}

	public holdAttachment(id: string, attachment: HostAttachment): void {
		this.#attachments.set(id, attachment);
	}

	/** Starts restoration. `before_agent_start` waits on `ready` so the turn sees the same ledger. */
	public reconcile(): Promise<LeaseReady> {
		if (this.#ready !== undefined) return this.#ready;
		const ready = this.#reconcile();
		this.#ready = ready;
		return ready;
	}

	public ready(): Promise<LeaseReady> {
		return this.reconcile();
	}

	async #reconcile(): Promise<LeaseReady> {
		const directory = this.#deps.directory;
		if (directory === undefined) {
			const recovery = await this.recover();
			return {
				ok: true,
				rebound: recovery.recovered,
				rehydrated: [],
				stopped: [],
				released: [],
			};
		}
		const lease = createConversationLease({
			registry: this.#deps.registry,
			hosts: directory,
			processes: { alive: processAlive },
			forgetRuntime: (runtimeIdentity) => {
				this.#deps.tokens?.forget(runtimeIdentity);
			},
		});
		const result = await lease.ready();
		if (!result.ok) return result;
		for (const id of result.rebound) {
			const record = await this.#deps.registry.get(id);
			const attachment = record?.runtime?.attachment;
			if (attachment?.kind === "panel") {
				const handle = directory.rebind?.(attachment);
				if (handle !== undefined) this.#attachments.set(id, handle);
			} else if (attachment?.kind === "process") {
				const runtime = attachRetainedChild(attachment.pid);
				if (runtime !== undefined) this.#watchRuntime(id, runtime);
			}
		}
		for (const id of result.released) {
			await this.#noteReleasedRuntime(id);
		}
		return result;
	}

	/** A writer the lease already dropped. Same ledger line as a watched exit. */
	async #noteReleasedRuntime(id: string): Promise<void> {
		const record = await this.#deps.registry.get(id);
		if (record?.state !== "blocked" || record.interrupted !== RUNTIME_ENDED_RESUME) return;
		this.#scheduleAutoReport(id, record);
	}

	#withSnapshot(record: SubagentRecord): SubagentRecord {
		const projector = this.#projectors.get(record.subagentId);
		if (projector === undefined) return record;
		const snap = projector.snapshot();
		return {
			...record,
			...(snap.activeTool !== undefined ? { activeTool: snap.activeTool } : {}),
			...(snap.summary !== undefined ? { latestSummary: snap.summary } : {}),
			...(snap.interrupted !== undefined ? { interrupted: snap.interrupted } : {}),
			usage: snap.usage ?? record.usage,
		};
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
			if (next.state === "running") this.#working.add(id);
			else if (next.state !== "error") this.#working.delete(id);
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

function durableProjection(
	record: SubagentRecord,
	snapshot: { readonly state: SubagentState; readonly interrupted?: string },
	inputConfirmed: boolean,
): true | undefined {
	if (inputConfirmed) return true;
	if (snapshot.state !== record.state) return true;
	return undefined;
}

function resumesChildWork(type: unknown): boolean {
	return (
		type === "agent_start" ||
		type === "turn_start" ||
		type === "auto_retry_start" ||
		type === "auto_retry"
	);
}

/** The last conversational message is an assistant reply that already finished. */
function persistedReplyFinished(entries: readonly unknown[]): boolean {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		const message = entry.message;
		if (message.role === "user") return false;
		if (message.role !== "assistant") continue;
		return (
			message.stopReason !== "error" &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "pending" &&
			message.stopReason !== "deferred"
		);
	}
	return false;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
