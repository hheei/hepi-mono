import { errorMessage, isRecord } from "@hheei/pi-ext-core";
import type {
	EffectiveLaunchConfig,
	OperationError,
	PublicSubagent,
	SendMode,
	SpawnSubagentInput,
	SubagentRecord,
	SubagentState,
} from "./domain.js";

import type { HostAttachment, HostCommandResult, HostKind, HostSelection } from "./host-adapter.js";
import { buildLaunchSpec, withBridgeToken } from "./launch-spec.js";
import type { SubagentRegistry } from "./registry.js";
import { isIdlePiState } from "./rpc-events.js";
import type { RuntimeTokenStore } from "./runtime.js";
import { planSessionPlacement } from "./session-bootstrap.js";
import { createStateProjector, type StateProjector } from "./state.js";

/**
 * A crashed TUI child is noticed by spawning an external CLI per attached child on every
 * tick, and the child's own RPC reports cover the common cases, so this stays far above the
 * latency the check actually needs.
 */
const HOST_WATCH_INTERVAL_MS = 5_000;
export const SUBAGENT_IDLE_TIMEOUT_MS = 30_000;

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

export interface RunnerLike {
	readonly connected: boolean;
	request(
		operation:
			| "prompt"
			| "steer"
			| "follow_up"
			| "get_state"
			| "get_entries"
			| "shutdown"
			| "pause"
			| "cancel_pause"
			| "close_writer"
			| "start_rpc",
		payload?: unknown,
		options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
	): Promise<unknown>;
	close(): void;
	onEvent(listener: (event: unknown) => void): () => void;
}

export interface AttachHost {
	select(preferredHost?: HostKind): Promise<HostSelection>;
}

export interface AttachOptions {
	readonly preferredHost?: HostKind;
	readonly signal?: AbortSignal;
}

export interface AttachResult {
	readonly child: PublicSubagent;
	readonly host: HostKind;
	readonly attachmentId: string;
}

export type DetachOrigin = "tui_exit" | "tui_crash" | "session_switch" | "manual";

export interface DetachOptions {
	readonly origin: DetachOrigin;
	/** Close the host pane. False when session B still owns that TUI process. */
	readonly closeHost?: boolean;
	/** Operation label reported in failures; defaults to "detach". */
	readonly operation?: string;
}

export interface ManagerDependencies {
	readonly parentSessionId: string;
	readonly registry: Pick<SubagentRegistry, "get" | "list" | "update">;
	readonly resolve: (input: SpawnSubagentInput) => Promise<EffectiveLaunchConfig>;
	readonly bootstrap: (input: {
		readonly parentSessionId: string;
		readonly task: string;
		readonly launchConfig: EffectiveLaunchConfig;
	}) => Promise<SubagentRecord>;
	readonly launch: (record: SubagentRecord) => Promise<RunnerLike>;
	readonly connect?: (record: SubagentRecord) => Promise<RunnerLike>;
	readonly deadlineMs?: number;
	readonly watchIntervalMs?: number;
	readonly idleTimeoutMs?: number;
	readonly channel?: ParentChannel;
	readonly attachHost?: AttachHost;
	readonly tokens?: RuntimeTokenStore;
}

export interface SpawnResult {
	readonly child: PublicSubagent;
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
		mode: record.mode,
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
async function waitForRunnerDisconnect(
	runner: RunnerLike,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (runner.connected) {
		if (signal?.aborted) throw new Error("Runner shutdown wait was aborted");
		if (Date.now() >= deadline) throw new Error("Runner did not disconnect after shutdown");
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
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

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Attach was cancelled");
}

function hostCleanupFailed(result: HostCommandResult): boolean {
	return result.timedOut || result.exitCode !== 0;
}

export class SubagentManager {
	readonly #deps: ManagerDependencies;
	readonly #chains = new Map<string, Promise<unknown>>();
	readonly #runners = new Map<string, RunnerLike>();
	readonly #projectors = new Map<string, StateProjector>();
	readonly #idleTimers = new Map<string, NodeJS.Timeout>();
	readonly #stopping = new Set<string>();
	readonly #frozen = new Set<string>();
	readonly #attachCancels = new Map<string, AbortController>();
	readonly #hostAttachments = new Map<string, HostAttachment>();
	readonly #hostWatches = new Map<string, AbortController>();
	readonly #tuiQuitExpected = new Set<string>();
	readonly #listeners = new Set<() => void>();

	public constructor(deps: ManagerDependencies) {
		this.#deps = deps;
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
	}

	#scheduleIdleHibernate(id: string): void {
		this.#clearIdleHibernate(id);
		const timer = setTimeout(() => {
			this.#idleTimers.delete(id);
			void this.#hibernate(id).catch((error) => {
				console.error(`pi-subagents: failed to hibernate idle child ${id}: ${errorMessage(error)}`);
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

	async #hibernate(id: string): Promise<void> {
		await this.#mutate(id, async () => {
			const record = await this.#deps.registry.get(id);
			if (record === undefined || record.state !== "idle" || record.intent === "stopped") {
				return;
			}
			const runner = this.#runners.get(id);
			if (runner !== undefined) {
				try {
					await withDeadline(
						runner.request("shutdown", undefined),
						this.#deps.deadlineMs ?? 10_000,
					).catch(() => undefined);
				} finally {
					runner.close();
					this.#runners.delete(id);
				}
			}
			let sessionPath = record.sessionPath;
			let persistence = record.persistence;
			try {
				const placement = await planSessionPlacement({
					sessionId: record.sessionId,
					cwd: record.cwd,
					sessionDir: record.launchConfig.sessionDir,
					persistence: record.persistence,
					...(record.sessionPath === undefined ? {} : { sessionPath: record.sessionPath }),
				});
				if (placement.persistence === "flushed" && placement.sessionPath !== undefined) {
					sessionPath = placement.sessionPath;
					persistence = "flushed";
				}
			} catch {
				// ignore session placement discovery failure
			}
			await this.#update(id, (current) => {
				if (current.state !== "idle" || current.intent === "stopped") return current;
				return {
					...current,
					state: "done",
					persistence,
					...(sessionPath === undefined ? {} : { sessionPath }),
					launchConfig:
						sessionPath === undefined
							? current.launchConfig
							: { ...current.launchConfig, sessionPath },
				};
			});
		});
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (error) {
				console.error(`pi-subagents: onChange listener failed: ${errorMessage(error)}`);
			}
		}
	}

	/** Reattaches active persisted children without replaying any historical input. */
	public async recover(): Promise<RecoveryResult> {
		const connect = this.#deps.connect;
		if (connect === undefined) return { recovered: [], failures: [] };
		const records = (await this.#deps.registry.list()).filter(
			(record) =>
				record.intent === "active" && record.state !== "done" && record.state !== "stopped",
		);
		const outcomes = await Promise.all(
			records.map(async (record) => {
				try {
					const runner = await withDeadline(connect(record), this.#deps.deadlineMs ?? 30_000);
					this.#attach(record, runner);
					const response = await runner.request("get_entries").catch(() => undefined);
					const entries =
						isRecord(response) && Array.isArray(response.entries) ? response.entries : [];
					const projector = this.#projectors.get(record.subagentId);
					projector?.rebuild(entries);
					const snapshot = projector?.snapshot();
					await this.#mutateUpdate(record.subagentId, (current) => {
						const interrupted =
							snapshot?.interrupted ??
							(current.unacknowledgedInput === undefined
								? current.interrupted
								: (current.interrupted ?? "Parent recovered; pending input was not replayed"));
						return {
							...current,
							...(snapshot === undefined
								? {}
								: {
										state: snapshot.state,
										...(snapshot.summary === undefined ? {} : { latestSummary: snapshot.summary }),
										usage: snapshot.usage,
									}),
							...(interrupted === undefined ? {} : { interrupted }),
						};
					});
					return { childId: record.subagentId };
				} catch (error) {
					return {
						childId: record.subagentId,
						reason: errorMessage(error),
					};
				}
			}),
		);
		this.#notify();
		return {
			recovered: outcomes
				.filter((outcome) => !("reason" in outcome))
				.map((outcome) => outcome.childId),
			failures: outcomes.filter(
				(outcome): outcome is { childId: string; reason: string } => "reason" in outcome,
			),
		};
	}

	public async spawn(input: SpawnSubagentInput): Promise<SpawnResult | OperationError> {
		if (input.task.trim() === "") return failure("spawn", "Task must not be empty");
		try {
			const config = await withDeadline(this.#deps.resolve(input), this.#deps.deadlineMs ?? 30_000);
			const record = await withDeadline(
				this.#deps.bootstrap({
					parentSessionId: this.#deps.parentSessionId,
					task: input.task,
					launchConfig: config,
				}),
				this.#deps.deadlineMs ?? 30_000,
			);
			this.#notify();
			const runner = await withDeadline(this.#deps.launch(record), this.#deps.deadlineMs ?? 30_000);
			this.#attach(record, runner);
			try {
				await withDeadline(
					runner.request("prompt", { message: input.task }),
					this.#deps.deadlineMs ?? 30_000,
				);
			} catch (error) {
				let failureState: SubagentState = "starting";
				try {
					await this.#mutateUpdate(record.subagentId, (current) => ({
						...current,
						state: "failed",
						interrupted: "Initial task delivery was not confirmed",
						unacknowledgedInput: input.task,
					}));
					failureState = "failed";
				} catch (updateError) {
					console.error(
						`pi-subagents: failed to persist initial delivery uncertainty for ${record.subagentId}: ${errorMessage(updateError)}`,
					);
				}
				return failure(
					"spawn",
					errorMessage(error),
					record.subagentId,
					failureState,
					[
						"registry record persisted",
						"runner launched",
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
				child: publicChild((await this.#deps.registry.get(record.subagentId)) ?? record, true),
			};
		} catch (error) {
			return failure("spawn", errorMessage(error), undefined, undefined, [], true);
		}
	}

	public send(
		id: string,
		message: string,
		mode: SendMode = "auto",
		signal?: AbortSignal,
	): Promise<OperationError | PublicSubagent> {
		this.#clearIdleHibernate(id);
		return this.#mutate(id, async () => {
			const record = await this.#deps.registry.get(id);
			if (record === undefined) return failure("send", "Unknown child", id);
			if (this.#frozen.has(id) || record.mode === "tui")
				return failure("send", "Child input is frozen for attach", id, record.state);
			if (record.intent === "stopped" || record.state === "stopped")
				return failure("send", "Child is stopped", id, record.state);
			if (record.state === "failed")
				return failure("send", "Child is not accepting input", id, record.state);

			let runner = this.#runners.get(id);
			let isResumed = false;

			// Auto-Resume: if the child finished/hibernated (done) or runner disconnected, resume it
			if (runner === undefined || record.state === "done") {
				let sessionPath = record.sessionPath;
				let persistence = record.persistence;
				try {
					const placement = await planSessionPlacement({
						sessionId: record.sessionId,
						cwd: record.cwd,
						sessionDir: record.launchConfig.sessionDir,
						persistence: record.persistence,
						...(record.sessionPath === undefined ? {} : { sessionPath: record.sessionPath }),
					});
					if (placement.persistence === "flushed" && placement.sessionPath !== undefined) {
						sessionPath = placement.sessionPath;
						persistence = "flushed";
					}
				} catch {
					// ignore
				}
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
				try {
					runner = await withDeadline(
						this.#deps.launch(resumedRecord),
						this.#deps.deadlineMs ?? 30_000,
					);
					this.#attach(resumedRecord, runner);
					isResumed = true;
				} catch (error) {
					return failure(
						"send",
						`Failed to resume subagent: ${errorMessage(error)}`,
						id,
						"failed",
						[],
						true,
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
			const pending = await this.#update(id, (current) => ({
				...current,
				state: "running",
				unacknowledgedInput: message,
				interrupted:
					"Input delivery was accepted for dispatch but is not yet confirmed in the session",
			}));
			try {
				await withDeadline(
					runner.request(operation, { message }, signal === undefined ? {} : { signal }),
					this.#deps.deadlineMs ?? 30_000,
				);
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
		const runner = this.#runners.get(id);
		return record === undefined
			? failure("get", "Unknown child", id)
			: publicChild(record, runner?.connected === true);
	}

	public async list(): Promise<readonly PublicSubagent[]> {
		const records = await this.#deps.registry.list();
		return records.map((record) =>
			publicChild(record, this.#runners.get(record.subagentId)?.connected === true),
		);
	}

	public stop(id: string, signal?: AbortSignal): Promise<OperationError | PublicSubagent> {
		this.#clearIdleHibernate(id);
		this.#attachCancels.get(id)?.abort();
		this.#stopHostWatch(id);
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
				stopped = await this.#update(id, (current) => ({
					...current,
					intent: "stopped",
					state: "stopped",
				}));
			} catch (error) {
				this.#stopping.delete(id);
				return failure("stop", errorMessage(error), id, record.state, [], true);
			}
			const runner = this.#runners.get(id);
			if (runner === undefined && stopped.runtime !== undefined) {
				this.#stopping.delete(id);
				return failure(
					"stop",
					"Runtime termination could not be confirmed because no live controller is attached",
					id,
					"stopped",
					["stopped intent persisted", "runtime metadata retained"],
					true,
				);
			}
			try {
				if (runner !== undefined) {
					await withDeadline(
						runner.request("shutdown", undefined, signal === undefined ? {} : { signal }),
						this.#deps.deadlineMs ?? 30_000,
					);
					await waitForRunnerDisconnect(runner, this.#deps.deadlineMs ?? 30_000, signal);
					runner.close();
					this.#runners.delete(id);
				}
				await this.#releaseHost(id);
				this.#frozen.delete(id);
				const runtimeIdentity = stopped.runtime?.runtimeIdentity;
				if (runtimeIdentity !== undefined) {
					this.#deps.tokens?.forget(runtimeIdentity);
					const current = await this.#deps.registry.get(id);
					if (current !== undefined) {
						stopped = await this.#deps.registry.update(
							id,
							current.revision,
							(value) => {
								const { runtime: _runtime, ...withoutRuntime } = value;
								return withoutRuntime;
							},
							runtimeIdentity,
						);
					}
				}
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

	public ownsHostAttachment(identity: {
		readonly host: HostKind;
		readonly attachmentId: string;
	}): boolean {
		for (const attachment of this.#hostAttachments.values()) {
			if (
				attachment.identity.host === identity.host &&
				attachment.identity.attachmentId === identity.attachmentId
			)
				return true;
		}
		return false;
	}

	public attach(id: string, options: AttachOptions = {}): Promise<AttachResult | OperationError> {
		const cancel = new AbortController();
		this.#attachCancels.set(id, cancel);
		if (options.signal?.aborted) cancel.abort();
		else options.signal?.addEventListener("abort", () => cancel.abort(), { once: true });
		this.#frozen.add(id);
		return this.#mutate(id, () =>
			this.#runAttach(id, options.preferredHost, cancel.signal),
		).finally(() => {
			this.#attachCancels.delete(id);
		});
	}

	public restoreRpc(id: string): Promise<OperationError | PublicSubagent> {
		return this.detach(id, { origin: "manual", closeHost: true, operation: "restore_rpc" });
	}

	public detach(id: string, options: DetachOptions): Promise<OperationError | PublicSubagent> {
		return this.#mutate(id, () => this.#runDetach(id, options));
	}

	public inspectHost(
		id: string,
	): Promise<
		| OperationError
		| PublicSubagent
		| { readonly alive: boolean; readonly known: boolean; readonly detail: string }
	> {
		return this.#mutate(id, async () => {
			const attachment = this.#hostAttachments.get(id);
			if (attachment === undefined) {
				return failure("inspect_host", "No host attachment is owned", id);
			}
			const observed = await attachment.observe();
			if (!observed.known || observed.alive) {
				return { alive: observed.alive, known: observed.known, detail: observed.detail };
			}
			return this.#runDetach(id, {
				origin: this.#tuiQuitExpected.has(id) ? "tui_exit" : "tui_crash",
				closeHost: true,
			});
		});
	}

	async #runAttach(
		id: string,
		preferredHost: HostKind | undefined,
		signal: AbortSignal,
	): Promise<AttachResult | OperationError> {
		const failBeforeClose = async (
			reason: string,
			record: SubagentRecord | undefined,
			sideEffects: readonly string[] = [],
		): Promise<OperationError> => {
			this.#frozen.delete(id);
			return failure("attach", reason, id, record?.state, sideEffects, true);
		};
		try {
			throwIfAborted(signal);
			const record = await this.#deps.registry.get(id);
			if (record === undefined) return failBeforeClose("Unknown child", undefined);
			if (record.intent === "stopped" || record.state === "stopped" || record.state === "done")
				return failBeforeClose("Child is not attachable", record);
			if (record.mode === "tui") return failBeforeClose("Child is already attached as TUI", record);
			const runner = this.#runners.get(id);
			if (runner === undefined || !runner.connected)
				return failBeforeClose("Child runtime is not live", record);
			const hostApi = this.#deps.attachHost;
			if (hostApi === undefined)
				return failBeforeClose("No presentation host is configured", record);
			const token =
				record.runtime === undefined
					? undefined
					: this.#deps.tokens?.get(record.runtime.runtimeIdentity);
			if (token === undefined)
				return failBeforeClose("Bridge token is unavailable for TUI launch", record);
			throwIfAborted(signal);
			const selection = await hostApi.select(preferredHost);
			if (!selection.available)
				return failBeforeClose(selection.reason, record, ["RPC writer retained"]);
			throwIfAborted(signal);
			const state = await withDeadline(
				runner.request("get_state", undefined, { signal }),
				this.#deps.deadlineMs ?? 30_000,
			);
			if (!isIdlePiState(state)) {
				try {
					await withDeadline(
						runner.request("pause", undefined, { signal }),
						this.#deps.deadlineMs ?? 30_000,
					);
				} catch (error) {
					try {
						await runner.request("cancel_pause");
					} catch {
						// Keep RPC; attach still fails below.
					}
					return failBeforeClose(
						error instanceof Error && error.message === "Attach was cancelled"
							? error.message
							: `Child did not pause before attach deadline: ${errorMessage(error)}`,
						record,
						["RPC writer retained"],
					);
				}
			}
			throwIfAborted(signal);
			const placement = await planSessionPlacement({
				sessionId: record.sessionId,
				cwd: record.cwd,
				sessionDir: record.launchConfig.sessionDir,
				persistence: record.persistence,
				...(record.sessionPath === undefined ? {} : { sessionPath: record.sessionPath }),
			});
			if (placement.persistence !== "flushed" || placement.sessionPath === undefined)
				return failBeforeClose("Session has not been flushed; attach refused", record, [
					"RPC writer retained",
				]);
			const sessionPath = placement.sessionPath;
			const flushed =
				sessionPath === record.sessionPath && record.persistence === "flushed"
					? record
					: await this.#update(id, (current) => ({
							...current,
							persistence: "flushed",
							sessionPath,
							launchConfig: { ...current.launchConfig, sessionPath },
						}));
			throwIfAborted(signal);
			await withDeadline(
				runner.request("close_writer", undefined, { signal }),
				this.#deps.deadlineMs ?? 30_000,
			);
			const writerClosed = true;
			try {
				throwIfAborted(signal);
				const launch = buildLaunchSpec({
					config: {
						...flushed.launchConfig,
						sessionPath,
					},
					invocation: flushed.launchConfig.invocation,
					mode: "tui",
					persistence: "flushed",
					bridge: {
						parentSessionId: flushed.parentSessionId,
						subagentId: flushed.subagentId,
						runtimeIdentity: flushed.runtime?.runtimeIdentity ?? "missing",
						endpoint: flushed.runtime?.endpoint ?? "",
					},
				});
				const attachment = await selection.adapter.attach({
					...launch,
					env: withBridgeToken(launch.env, token),
				});
				if (signal.aborted) {
					this.#hostAttachments.set(id, attachment);
					const restored = await this.#restoreRpcAfterHost(id, runner);
					this.#frozen.delete(id);
					return failure("attach", "Attach was cancelled", id, flushed.state, [restored], false);
				}
				const observed = await attachment.observe();
				if (attachment.launch.timedOut && !observed.known) {
					this.#hostAttachments.set(id, attachment);
					this.#watchHost(id);
					await this.#update(id, (current) => ({ ...current, mode: "tui" }));
					this.#frozen.delete(id);
					return failure(
						"attach",
						"Host timed out and TUI writer state is unknown; not starting another writer",
						id,
						flushed.state,
						["RPC writer closed", "TUI writer state unknown"],
						false,
					);
				}
				if (attachment.launch.timedOut && !observed.alive) {
					this.#hostAttachments.set(id, attachment);
					const restored = await this.#restoreRpcAfterHost(id, runner);
					this.#frozen.delete(id);
					return failure(
						"attach",
						"Host timed out and TUI writer was not confirmed",
						id,
						flushed.state,
						[restored, "pending input was not replayed"],
						false,
					);
				}
				if (attachment.launch.timedOut && observed.alive) {
					this.#hostAttachments.set(id, attachment);
					this.#watchHost(id);
					await this.#update(id, (current) => ({ ...current, mode: "tui" }));
					return failure(
						"attach",
						"Host timed out after TUI started; not starting another writer",
						id,
						"idle",
						["TUI writer may be live", "RPC writer closed"],
						false,
					);
				}
				this.#hostAttachments.set(id, attachment);
				this.#watchHost(id);
				const next = await this.#update(id, (current) => ({
					...current,
					mode: "tui",
					state: "idle",
				}));
				return {
					child: publicChild(next, true),
					host: selection.selectedHost,
					attachmentId: attachment.identity.attachmentId,
				};
			} catch (error) {
				if (!writerClosed) throw error;
				const restored = await this.#restoreRpcAfterHost(id, runner);
				this.#frozen.delete(id);
				return failure(
					"attach",
					errorMessage(error),
					id,
					flushed.state,
					[restored, "pending input was not replayed"],
					false,
				);
			}
		} catch (error) {
			this.#frozen.delete(id);
			return failure("attach", errorMessage(error), id, undefined, ["RPC writer retained"], true);
		}
	}

	async #restoreRpcAfterHost(id: string, runner: RunnerLike): Promise<string> {
		try {
			await this.#releaseHost(id);
		} catch (error) {
			return `RPC not restored: ${errorMessage(error)}`;
		}
		return this.#restoreRpc(id, runner);
	}

	async #restoreRpc(id: string, runner: RunnerLike): Promise<string> {
		try {
			await withDeadline(runner.request("start_rpc"), this.#deps.deadlineMs ?? 30_000);
			await this.#update(id, (current) => ({ ...current, mode: "rpc" }));
			return "RPC writer restored; waiting for input";
		} catch (error) {
			return `RPC restore failed: ${errorMessage(error)}`;
		}
	}

	async #releaseHost(id: string): Promise<void> {
		this.#stopHostWatch(id);
		const attachment = this.#hostAttachments.get(id);
		if (attachment === undefined) return;
		const result = await attachment.cleanup();
		if (hostCleanupFailed(result)) {
			throw new Error(result.stderr || result.stdout || "Host cleanup failed");
		}
		const observed = await attachment.observe();
		if (!observed.known || observed.alive) {
			throw new Error(
				observed.known
					? `TUI writer still alive after cleanup: ${observed.detail}`
					: `TUI writer state unknown after cleanup: ${observed.detail}`,
			);
		}
		this.#hostAttachments.delete(id);
	}

	#stopHostWatch(id: string): void {
		const watch = this.#hostWatches.get(id);
		if (watch === undefined) return;
		watch.abort();
		this.#hostWatches.delete(id);
	}

	#watchHost(id: string): void {
		this.#stopHostWatch(id);
		const attachment = this.#hostAttachments.get(id);
		if (attachment === undefined) return;
		const stop = new AbortController();
		this.#hostWatches.set(id, stop);
		const intervalMs = this.#deps.watchIntervalMs ?? HOST_WATCH_INTERVAL_MS;
		const tick = (): void => {
			if (stop.signal.aborted) return;
			if (this.#hostAttachments.get(id) !== attachment) return;
			void attachment.observe().then((observed) => {
				if (stop.signal.aborted) return;
				if (this.#hostAttachments.get(id) !== attachment) return;
				if (!observed.known || observed.alive) return;
				const origin = this.#tuiQuitExpected.has(id) ? "tui_exit" : "tui_crash";
				this.#tuiQuitExpected.delete(id);
				void this.detach(id, { origin, closeHost: true }).catch((error: unknown) => {
					console.error(
						`pi-subagents: detach after TUI exit failed for ${id}: ${errorMessage(error)}`,
					);
				});
			});
		};
		const timer = setInterval(tick, intervalMs);
		stop.signal.addEventListener(
			"abort",
			() => {
				clearInterval(timer);
			},
			{ once: true },
		);
		tick();
	}

	async #runDetach(id: string, options: DetachOptions): Promise<OperationError | PublicSubagent> {
		const operation = options.operation ?? "detach";
		const record = await this.#deps.registry.get(id);
		if (record === undefined) return failure(operation, "Unknown child", id);
		if (record.intent === "stopped" || record.state === "stopped") {
			this.#stopHostWatch(id);
			return failure(operation, "Stopped child is not restored", id, "stopped", [], false);
		}
		if (record.mode !== "tui") {
			return publicChild(record, this.#runners.get(id)?.connected === true);
		}
		this.#stopHostWatch(id);
		if (options.closeHost === false) {
			this.#hostAttachments.delete(id);
		} else {
			try {
				await this.#releaseHost(id);
			} catch (error) {
				this.#frozen.delete(id);
				return failure(
					operation,
					errorMessage(error),
					id,
					record.state,
					["TUI writer was not confirmed gone"],
					false,
				);
			}
		}
		const runner = this.#runners.get(id);
		if (runner === undefined || !runner.connected) {
			this.#frozen.delete(id);
			return failure(operation, "Child runtime is not live", id);
		}
		const restored = await this.#restoreRpc(id, runner);
		this.#frozen.delete(id);
		const next = await this.#deps.registry.get(id);
		if (next === undefined) return failure(operation, "Unknown child", id);
		if (restored.startsWith("RPC restore failed")) {
			return failure(operation, restored, id, next.state, [restored], false);
		}
		if (options.origin === "tui_crash") {
			await this.#update(id, (current) => ({
				...current,
				interrupted: "TUI exited abnormally; RPC restored waiting for input",
			}));
			await this.contactParent(
				id,
				"tui_crash",
				"Child TUI exited abnormally. RPC was restored and is waiting for input. Pending work was not replayed.",
			);
		}
		return publicChild((await this.#deps.registry.get(id)) ?? next, true);
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
			return { delivered: true };
		} catch (error) {
			return failure("contact_parent", errorMessage(error), id, record.state, [], true);
		}
	}

	public closeLocalConnections(): void {
		this.dispose();
		for (const id of [...this.#hostWatches.keys()]) this.#stopHostWatch(id);
		for (const runner of this.#runners.values()) runner.close();
		this.#runners.clear();
		this.#deps.tokens?.clear();
		this.#notify();
	}

	async #observe(id: string, event: unknown, runner: RunnerLike): Promise<void> {
		if (this.#runners.get(id) !== runner) return;
		const value = isRecord(event) ? event : undefined;
		if (value === undefined) return;
		if (value.type === "subagent_report") {
			const report = isRecord(value.report) ? value.report : undefined;
			if (
				report?.type === "pi_subagent_report" &&
				typeof report.parentSessionId === "string" &&
				typeof report.childId === "string" &&
				typeof report.runtimeIdentity === "string" &&
				typeof report.reason === "string" &&
				typeof report.message === "string"
			) {
				const record = await this.#deps.registry.get(id);
				if (
					record === undefined ||
					record.intent === "stopped" ||
					report.parentSessionId !== record.parentSessionId ||
					report.childId !== id ||
					report.runtimeIdentity !== record.runtime?.runtimeIdentity
				)
					return;
				await this.contactParent(id, report.reason, report.message);
			}
			return;
		}
		if (value.type === "child_lifecycle") {
			const record = await this.#deps.registry.get(id);
			if (
				record === undefined ||
				record.intent === "stopped" ||
				typeof value.kind !== "string" ||
				typeof value.parentSessionId !== "string" ||
				typeof value.childId !== "string" ||
				typeof value.runtimeIdentity !== "string" ||
				value.parentSessionId !== record.parentSessionId ||
				value.childId !== id ||
				value.runtimeIdentity !== record.runtime?.runtimeIdentity
			)
				return;
			if (value.kind === "tui_quit") {
				this.#tuiQuitExpected.add(id);
				return;
			}
			if (value.kind === "user_interrupt") {
				const message =
					typeof value.message === "string" && value.message !== ""
						? value.message
						: "Task is unfinished and waiting for user intent.";
				await this.#update(id, (current) => ({
					...current,
					interrupted: message,
				}));
				await this.contactParent(id, "user_interrupt", message);
				return;
			}
			if (value.kind === "left_session") {
				await this.#runDetach(id, { origin: "session_switch", closeHost: false });
			}
			return;
		}
		const projector = this.#projectors.get(id);
		if (projector === undefined) return;
		projector.applyEvent(event);
		let confirmedInput: string | undefined;
		if (value.type === "agent_end" || value.type === "runner_events_dropped") {
			const response = await runner.request("get_entries").catch(() => undefined);
			const entries = isRecord(response) && Array.isArray(response.entries) ? response.entries : [];
			projector.rebuild(entries);
			if (value.type === "agent_end") {
				const record = await this.#deps.registry.get(id);
				if (
					record?.unacknowledgedInput !== undefined &&
					sessionContainsUserInput(entries, record.unacknowledgedInput)
				)
					confirmedInput = record.unacknowledgedInput;
			} else {
				const piState = await runner.request("get_state").catch(() => undefined);
				if (isIdlePiState(piState)) projector.applyEvent({ type: "agent_settled" });
				else if (
					isRecord(piState) &&
					(piState.isStreaming === true || piState.isCompacting === true)
				) {
					projector.applyEvent({ type: "agent_start" });
				}
			}
		}
		if (value.type === "runner_exit") {
			this.#runners.delete(id);
			runner.close();
		}
		const current = await this.#deps.registry.get(id);
		if (current === undefined || current.intent === "stopped") return;
		const snapshot = projector.snapshot();
		await this.#update(id, (record) => {
			const base =
				confirmedInput === undefined
					? record
					: (({ unacknowledgedInput: _input, interrupted: _interrupted, ...rest }) => rest)(record);
			return {
				...base,
				state: snapshot.state,
				...(snapshot.summary === undefined ? {} : { latestSummary: snapshot.summary }),
				usage: snapshot.usage,
				...(snapshot.interrupted === undefined ? {} : { interrupted: snapshot.interrupted }),
			};
		});
		if (snapshot.state === "idle") {
			this.#scheduleIdleHibernate(id);
		} else {
			this.#clearIdleHibernate(id);
		}
	}
	#attach(record: SubagentRecord, runner: RunnerLike): void {
		this.#runners.get(record.subagentId)?.close();
		this.#runners.set(record.subagentId, runner);
		this.#projectors.set(record.subagentId, createStateProjector(record.state));
		runner.onEvent((event) => {
			void this.#mutate(record.subagentId, () =>
				this.#observe(record.subagentId, event, runner),
			).catch((error: unknown) => {
				console.error(
					`pi-subagents: failed to project event for ${record.subagentId}: ${errorMessage(error)}`,
				);
			});
		});
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
	): Promise<SubagentRecord> {
		// The store re-reads the record inside its own write, so an undefined revision cannot
		// lose a concurrent field update and no stale_revision retry is needed.
		const next = await this.#deps.registry.update(id, undefined, updater);
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
