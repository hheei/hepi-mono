import type {
	EffectiveLaunchConfig,
	OperationError,
	PublicSubagent,
	SendMode,
	SpawnSubagentInput,
	SubagentRecord,
	SubagentState,
} from "./domain.js";
import { isRecord } from "./domain.js";
import type { SubagentRegistry } from "./registry.js";
import type { StateProjector } from "./state.js";
import { createStateProjector } from "./state.js";

export interface ParentChannelReport {
	readonly parentSessionId: string;
	readonly childId: string;
	readonly task: string;
	readonly status: SubagentState;
	readonly reason: string;
	readonly message: string;
}

export interface ParentChannel {
	deliver(report: ParentChannelReport): Promise<void>;
	online(): void;
	offline(): void;
	drain(): readonly ParentChannelReport[];
}

export function createParentChannel(options: {
	readonly capacity?: number;
	readonly deliverOnline: (report: ParentChannelReport) => Promise<void>;
}): ParentChannel {
	const capacity = Math.max(1, options.capacity ?? 32);
	const queue: ParentChannelReport[] = [];
	let connected = true;
	return {
		async deliver(report) {
			if (connected) {
				await options.deliverOnline(report);
				return;
			}
			if (queue.length >= capacity) throw new Error("Parent report queue is full");
			queue.push(report);
		},
		online() {
			connected = true;
		},
		offline() {
			connected = false;
		},
		drain() {
			return queue.splice(0, queue.length);
		},
	};
}

export interface RunnerLike {
	readonly connected: boolean;
	request(
		operation: "prompt" | "steer" | "follow_up" | "get_state" | "get_entries" | "shutdown",
		payload?: unknown,
		options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
	): Promise<unknown>;
	close(): void;
	onEvent(listener: (event: unknown) => void): () => void;
}

export interface ManagerDependencies {
	readonly parentSessionId: string;
	readonly registry: SubagentRegistry;
	readonly resolve: (input: SpawnSubagentInput) => Promise<EffectiveLaunchConfig>;
	readonly bootstrap: (input: {
		readonly parentSessionId: string;
		readonly task: string;
		readonly launchConfig: EffectiveLaunchConfig;
	}) => Promise<SubagentRecord>;
	readonly launch: (record: SubagentRecord) => Promise<RunnerLike>;
	readonly connect?: (record: SubagentRecord) => Promise<RunnerLike>;
	readonly deadlineMs?: number;
	readonly channel?: ParentChannel;
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
		state: record.state,
		mode: record.mode,
		cwd: record.cwd,
		sessionId: record.sessionId,
		...(record.latestSummary === undefined ? {} : { summary: record.latestSummary }),
		...(record.usage === undefined ? {} : { usage: record.usage }),
		...(record.interrupted === undefined ? {} : { interrupted: record.interrupted }),
		freshness: live ? "live" : "last_known",
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

export class SubagentManager {
	readonly #deps: ManagerDependencies;
	readonly #chains = new Map<string, Promise<unknown>>();
	readonly #runners = new Map<string, RunnerLike>();
	readonly #projectors = new Map<string, StateProjector>();
	readonly #stopping = new Set<string>();

	public constructor(deps: ManagerDependencies) {
		this.#deps = deps;
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
					if (projector !== undefined) {
						const snapshot = projector.snapshot();
						await this.#update(record.subagentId, (current) => ({
							...current,
							state: snapshot.state,
							...(snapshot.summary === undefined ? {} : { latestSummary: snapshot.summary }),
							usage: snapshot.usage,
							...(snapshot.interrupted === undefined ? {} : { interrupted: snapshot.interrupted }),
						}));
					}
					return { childId: record.subagentId };
				} catch (error) {
					return {
						childId: record.subagentId,
						reason: error instanceof Error ? error.message : String(error),
					};
				}
			}),
		);
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
					await this.#update(record.subagentId, (current) => ({
						...current,
						state: "failed",
						interrupted: "Initial task delivery was not confirmed",
						unacknowledgedInput: input.task,
					}));
					failureState = "failed";
				} catch (updateError) {
					console.error(
						`pi-subagents: failed to persist initial delivery uncertainty for ${record.subagentId}: ${updateError instanceof Error ? updateError.message : String(updateError)}`,
					);
				}
				return failure(
					"spawn",
					error instanceof Error ? error.message : String(error),
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
			await this.#update(record.subagentId, (current) => {
				const { latestSummary: _latestSummary, ...rest } = current;
				return { ...rest, state: "running" };
			});
			return {
				child: publicChild((await this.#deps.registry.get(record.subagentId)) ?? record, true),
			};
		} catch (error) {
			return failure(
				"spawn",
				error instanceof Error ? error.message : String(error),
				undefined,
				undefined,
				[],
				true,
			);
		}
	}

	public send(
		id: string,
		message: string,
		mode: SendMode = "auto",
		signal?: AbortSignal,
	): Promise<OperationError | PublicSubagent> {
		return this.#mutate(id, async () => {
			const record = await this.#deps.registry.get(id);
			if (record === undefined) return failure("send", "Unknown child", id);
			if (
				record.intent === "stopped" ||
				record.state === "done" ||
				record.state === "failed" ||
				record.state === "stopped"
			)
				return failure("send", "Child is not accepting input", id, record.state);
			const runner = this.#runners.get(id);
			if (runner === undefined)
				return failure("send", "Child runtime is not live", id, record.state, [], true);
			const state = record.state;
			const operation =
				mode === "auto"
					? state === "running"
						? "steer"
						: state === "idle"
							? "follow_up"
							: undefined
					: mode;
			if (operation === undefined)
				return failure("send", "Cannot infer send mode from unknown state", id, state);
			const pending = await this.#update(id, (current) => ({
				...current,
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
					error instanceof Error ? error.message : String(error),
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
		return this.#mutate(id, async () => {
			if (this.#stopping.has(id)) return this.get(id);
			this.#stopping.add(id);
			let record: SubagentRecord | undefined;
			try {
				record = await this.#deps.registry.get(id);
			} catch (error) {
				this.#stopping.delete(id);
				return failure(
					"stop",
					error instanceof Error ? error.message : String(error),
					id,
					undefined,
					[],
					true,
				);
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
				return failure(
					"stop",
					error instanceof Error ? error.message : String(error),
					id,
					record.state,
					[],
					true,
				);
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
				const runtimeIdentity = stopped.runtime?.runtimeIdentity;
				if (runtimeIdentity !== undefined) {
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
					error instanceof Error ? error.message : String(error),
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
				task: record.initialTask,
				status: record.state,
				reason,
				message,
			});
			return { delivered: true };
		} catch (error) {
			return failure(
				"contact_parent",
				error instanceof Error ? error.message : String(error),
				id,
				record.state,
				[],
				true,
			);
		}
	}

	public closeLocalConnections(): void {
		for (const runner of this.#runners.values()) runner.close();
		this.#runners.clear();
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
		const projector = this.#projectors.get(id);
		if (projector === undefined) return;
		projector.applyEvent(event);
		let confirmedInput: string | undefined;
		if (value.type === "agent_end") {
			const response = await runner.request("get_entries").catch(() => undefined);
			const entries = isRecord(response) && Array.isArray(response.entries) ? response.entries : [];
			projector.rebuild(entries);
			const record = await this.#deps.registry.get(id);
			if (
				record?.unacknowledgedInput !== undefined &&
				sessionContainsUserInput(entries, record.unacknowledgedInput)
			)
				confirmedInput = record.unacknowledgedInput;
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
					`pi-subagents: failed to project event for ${record.subagentId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		});
	}
	async #update(
		id: string,
		updater: (record: SubagentRecord) => SubagentRecord,
	): Promise<SubagentRecord> {
		const current = await this.#deps.registry.get(id);
		if (current === undefined) throw new Error("Child disappeared");
		return this.#deps.registry.update(id, current.revision, updater);
	}
	#mutate<T>(id: string, action: () => Promise<T>): Promise<T> {
		const previous = this.#chains.get(id) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(action);
		this.#chains.set(id, next);
		void next.finally(() => {
			if (this.#chains.get(id) === next) this.#chains.delete(id);
		});
		return next;
	}
}
