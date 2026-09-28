import { createServiceKey, type ServiceKey } from "./service.js";

/**
 * Shared background-task contract.
 *
 * A task is one execution that produces exactly one terminal result. Producers own
 * execution, cancellation and lifecycle; this registry only assigns identity, keeps one
 * terminal result per task, and answers list/wait/stop. It performs no scheduling, no
 * model routing and no parent-session messaging: a delivery adapter owns notification
 * policy and subscribes to terminal events.
 */

export type TaskStatus = "queued" | "starting" | "running" | TaskTerminalStatus;

export type TaskTerminalStatus = "completed" | "failed" | "cancelled" | "timed_out";

/** Notification bookkeeping for a terminal result. */
export type TaskDeliveryState = "pending" | "submitted" | "observed";
/** Undelivered results reserve capacity so admission can fail before work is lost. */
export const DEFAULT_MAX_PENDING_DELIVERIES = 64;
/** Terminal records kept for lookup after delivery; undelivered records are protected. */
export const DEFAULT_MAX_RETAINED_TERMINAL = 64;
/** Hard bound on one stored terminal output; producers must bind structured results tighter. */
export const MAX_TASK_RESULT_CHARS = 64 * 1024;

export interface TaskProgress {
	readonly output: string;
	readonly truncated: boolean;
}

export interface TaskTerminal extends TaskProgress {
	readonly status: TaskTerminalStatus;
	/** Producer-owned typed detail. Never parsed back out of `output`. */
	readonly detail?: Readonly<Record<string, unknown>>;
	/** Validated structured result; present only when the producer validated it. */
	readonly structured?: unknown;
}

/** Producer-owned control surface. The producer still settles the task when work stops. */
export interface TaskBinding {
	/** Requests cancellation; it does not by itself terminalize the task. */
	stop(): void;
	/** Current output of a task that has not reached a terminal state. */
	describe(): TaskProgress;
}

export interface TaskRequest {
	/** Task family and id prefix: `bash` becomes `bash-<runtime>-3`. */ readonly type: string;
	/** One-line intent shown to the model, the user and terminal deliveries. */
	readonly purpose: string;
	/**
	 * Opaque branch marker captured when the task started, used by a delivery adapter to
	 * avoid injecting results into a branch that no longer contains its starting point.
	 */
	readonly anchor?: string;
	/** Producers that start asynchronously admit as `queued` or `starting`. */
	readonly initialStatus?: "queued" | "starting" | "running";
	/**
	 * Optional synchronous starter. Producers with asynchronous startup omit it and
	 * attach their control surface later with `bind`.
	 */
	begin?(taskId: string): TaskBinding;
}

export interface TaskSnapshot {
	readonly id: string;
	/** UI abbreviation. Control entries only accept the full `id`. */
	readonly shortId: string;
	readonly type: string;
	readonly status: TaskStatus;
	readonly purpose: string;
	readonly startedAt: number;
	readonly endedAt?: number;
	/**
	 * Parent notification state. Absent while the task is still active, and also absent on a
	 * terminal record that needs no notification because its result was reported inline.
	 */
	readonly delivery?: TaskDeliveryState;
}

export interface TaskWaitOutcomeSettled {
	readonly id: string;
	readonly status: TaskStatus;
	/** False when the wait was cancelled before this task reached a terminal state. */
	readonly waited: boolean;
	readonly truncated: boolean;
	readonly output: string;
	readonly delivery?: TaskDeliveryState;
	readonly structured?: unknown;
}

export type TaskWaitOutcome =
	| { readonly id: string; readonly status: "not_found" }
	| TaskWaitOutcomeSettled;

export type TaskStopOutcome =
	| { readonly id: string; readonly status: "not_found" }
	| { readonly id: string; readonly status: "already_terminal" }
	| { readonly id: string; readonly status: "stop_failed" }
	| { readonly id: string; readonly status: "stop_requested" };

/** Pure state notification. Consumers derive their own policy from it. */
export interface TaskTerminalEvent {
	readonly id: string;
	readonly shortId: string;
	readonly type: string;
	readonly purpose: string;
	readonly status: TaskTerminalStatus;
	readonly output: string;
	readonly truncated: boolean;
	readonly detail?: Readonly<Record<string, unknown>>;
	readonly anchor?: string;
}

export interface TaskRegistryOptions {
	/** Cap on active tasks plus undelivered results, enforced at admission. */
	readonly maxPendingDeliveries?: number;
	/** Cap on retained terminal records; results still pending notification are protected. */
	readonly maxRetainedTerminal?: number;
	/** Called when a task is admitted while nothing else of this session needed control. */
	readonly onFirstTask?: () => void;
	/** Deterministic id discriminator for tests; production uses a random UUID prefix. */
	readonly runtimeDiscriminator?: string;
}

/** True for the statuses that end a task's life. */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
	return (
		status === "completed" ||
		status === "failed" ||
		status === "cancelled" ||
		status === "timed_out"
	);
}

/** Thrown when a caller submits work to a registry that was already disposed. */
export class TaskRegistryClosedError extends Error {
	constructor() {
		super("Task registry is disposed");
		this.name = "TaskRegistryClosedError";
	}
}

/** Thrown at admission when undelivered results already reserve the whole budget. */
export class TaskCapacityError extends Error {
	constructor(limit: number) {
		super(
			`Background task capacity is full: ${limit} active or undelivered results. ` +
				"Wait for or stop a task before starting another.",
		);
		this.name = "TaskCapacityError";
	}
}

interface TaskRecord {
	readonly id: string;
	readonly shortId: string;
	readonly type: string;
	readonly purpose: string;
	readonly startedAt: number;
	readonly anchor: string | undefined;
	status: TaskStatus;
	endedAt: number | undefined;
	binding: TaskBinding | undefined;
	terminal: TaskTerminal | undefined;
	delivery: TaskDeliveryState | undefined;
	batch: string | undefined;
	waiters: Array<(waited: boolean) => void>;
}

function randomDiscriminator(): string {
	return crypto.randomUUID().slice(0, 8);
}

function boundedOutput(output: string): { output: string; truncated: boolean } {
	if (output.length <= MAX_TASK_RESULT_CHARS) return { output, truncated: false };
	return { output: output.slice(-MAX_TASK_RESULT_CHARS), truncated: true };
}

function terminalEvent(record: TaskRecord, terminal: TaskTerminal): TaskTerminalEvent {
	const bounded = boundedOutput(terminal.output);
	return {
		id: record.id,
		shortId: record.shortId,
		type: record.type,
		purpose: record.purpose,
		status: terminal.status,
		output: bounded.output,
		truncated: terminal.truncated || bounded.truncated,
		...(terminal.detail === undefined ? {} : { detail: terminal.detail }),
		...(record.anchor === undefined ? {} : { anchor: record.anchor }),
	};
}

/**
 * Session runtime registry for background work owned by extension producers.
 *
 * Producers keep running their work and settle their task with one terminal result. The
 * registry assigns ids (`<type>-<runtime>-<sequence>`), serializes one terminal commit per
 * task, protects undelivered results from eviction, and answers list/wait/stop.
 */
export class TaskRegistry {
	readonly #records = new Map<string, TaskRecord>();
	readonly #counters = new Map<string, number>();
	readonly #listeners = new Set<(event: TaskTerminalEvent) => void>();
	readonly #discriminator: string;
	readonly #maxPending: number;
	readonly #maxRetained: number;
	readonly #onFirstTask: (() => void) | undefined;
	#closed = false;

	constructor(options: TaskRegistryOptions = {}) {
		this.#discriminator = options.runtimeDiscriminator ?? randomDiscriminator();
		this.#maxPending = options.maxPendingDeliveries ?? DEFAULT_MAX_PENDING_DELIVERIES;
		this.#maxRetained = options.maxRetainedTerminal ?? DEFAULT_MAX_RETAINED_TERMINAL;
		this.#onFirstTask = options.onFirstTask;
	}

	/** Tasks that have not reached a terminal state yet. */
	get activeCount(): number {
		let count = 0;
		for (const record of this.#records.values()) {
			if (isActive(record.status)) count += 1;
		}
		return count;
	}

	/** Terminal results that still reserve notification capacity. */
	get pendingDeliveryCount(): number {
		let count = 0;
		for (const record of this.#records.values()) {
			if (record.delivery === "pending") count += 1;
		}
		return count;
	}

	/** True while control tools must stay available for this session. */
	get requiresControl(): boolean {
		return this.activeCount > 0 || this.pendingDeliveryCount > 0;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Adds a terminal-state listener. */
	onTerminal(listener: (event: TaskTerminalEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/**
	 * Admits one task. A synchronous `begin` failure settles the task as failed and
	 * rethrows, because that error reaches the caller directly and is not background output.
	 */
	create(request: TaskRequest): TaskSnapshot {
		this.#assertOpen();
		const wasIdle = !this.requiresControl;
		if (this.activeCount + this.pendingDeliveryCount >= this.#maxPending)
			throw new TaskCapacityError(this.#maxPending);
		const status = request.initialStatus ?? "running";
		const { id, shortId } = this.#nextId(request.type);
		const record: TaskRecord = {
			id,
			shortId,
			type: request.type,
			purpose: request.purpose,
			startedAt: Date.now(),
			anchor: request.anchor,
			status,
			endedAt: undefined,
			binding: undefined,
			terminal: undefined,
			delivery: undefined,
			batch: undefined,
			waiters: [],
		};
		this.#records.set(id, record);
		if (request.begin !== undefined) {
			try {
				record.binding = request.begin(id);
			} catch (error) {
				record.status = "failed";
				record.endedAt = Date.now();
				record.terminal = {
					status: "failed",
					output: error instanceof Error ? error.message : String(error),
					truncated: false,
				};
				// The error reaches the caller directly, so it is not a background result and
				// must not reserve notification capacity or be announced twice.
				this.#release(record, false);
				this.#evict();
				throw error;
			}
		}
		if (wasIdle) {
			try {
				this.#onFirstTask?.();
			} catch {
				// Activation is best effort: it must never fail the task that just started.
			}
		}
		return this.#snapshot(record);
	}

	/**
	 * Attaches the control surface of an asynchronously started task. Returns false when the
	 * task was already stopped, in which case the binding is stopped immediately so a late
	 * startup cannot leave an orphan running.
	 */
	bind(id: string, binding: TaskBinding): boolean {
		const record = this.#records.get(id);
		if (record === undefined || record.binding !== undefined) return false;
		if (!isActive(record.status)) {
			stopBinding(binding);
			return false;
		}
		record.binding = binding;
		return true;
	}

	/** Moves an admitted task forward; a terminal task is never revived. */
	markRunning(id: string): void {
		const record = this.#records.get(id);
		if (record === undefined || !isActive(record.status)) return;
		record.status = "running";
	}

	/**
	 * Marks a task whose startup has begun but whose execution is not yet confirmed.
	 * Admission through a bounded queue makes `queued` a real, observable state, so the
	 * step between admission and a running execution must be observable too.
	 */
	markStarting(id: string): void {
		const record = this.#records.get(id);
		if (record === undefined || record.status !== "queued") return;
		record.status = "starting";
	}

	/** Records the single terminal result of one task. Repeat calls are ignored. */
	settle(id: string, terminal: TaskTerminal): boolean {
		const record = this.#records.get(id);
		if (record === undefined || !isActive(record.status)) return false;
		this.#settle(record, terminal);
		return true;
	}

	get(id: string): TaskSnapshot | undefined {
		const record = this.#records.get(id);
		return record === undefined ? undefined : this.#snapshot(record);
	}

	list(includeTerminal = false): readonly TaskSnapshot[] {
		const snapshots: TaskSnapshot[] = [];
		for (const record of this.#records.values()) {
			if (includeTerminal || isActive(record.status)) snapshots.push(this.#snapshot(record));
		}
		return snapshots;
	}

	async wait(ids: readonly string[], signal?: AbortSignal): Promise<readonly TaskWaitOutcome[]> {
		const outcomes: TaskWaitOutcome[] = [];
		for (const id of uniqueIds(ids)) {
			const record = this.#records.get(id);
			if (record === undefined) {
				outcomes.push({ id, status: "not_found" });
				continue;
			}
			const waited = await this.#waitFor(record, signal);
			outcomes.push(this.#outcome(record, waited));
		}
		return outcomes;
	}

	stop(ids: readonly string[]): readonly TaskStopOutcome[] {
		return uniqueIds(ids).map((id): TaskStopOutcome => {
			const record = this.#records.get(id);
			if (record === undefined) return { id, status: "not_found" };
			if (!isActive(record.status)) return { id, status: "already_terminal" };
			try {
				record.binding?.stop();
			} catch {
				return { id, status: "stop_failed" };
			}
			return { id, status: "stop_requested" };
		});
	}

	/** Terminal records whose result still needs parent notification. */
	pendingDeliveries(): readonly TaskTerminalEvent[] {
		const events: TaskTerminalEvent[] = [];
		for (const record of this.#records.values()) {
			if (record.delivery !== "pending" || record.terminal === undefined) continue;
			events.push(terminalEvent(record, record.terminal));
		}
		return events;
	}

	/**
	 * Marks results as handed to the parent session. This releases their capacity reservation
	 * and their eviction protection: the registry can no longer lose them, but confirmation of
	 * model context arrives separately through `markObserved`.
	 */
	markSubmitted(ids: readonly string[], batch: string): void {
		for (const id of ids) {
			const record = this.#records.get(id);
			if (record === undefined || record.delivery !== "pending") continue;
			record.delivery = "submitted";
			record.batch = batch;
			this.#evict();
		}
	}

	/** Marks results whose parent-session message lifecycle was observed. */
	markObserved(batch: string): void {
		for (const record of this.#records.values()) {
			if (record.delivery === "submitted" && record.batch === batch) record.delivery = "observed";
		}
		this.#evict();
	}

	/**
	 * Reverts an unsuccessful submission so the results stay deliverable. Safe because a
	 * rejected `sendMessage` cannot have emitted the message lifecycle event first.
	 */
	requeue(batch: string): void {
		for (const record of this.#records.values()) {
			if (record.delivery !== "submitted" || record.batch !== batch) continue;
			record.delivery = "pending";
			record.batch = undefined;
		}
	}

	/**
	 * Ends observation and releases every reservation. Producers still settle into a closed
	 * registry so a late terminal result can never resurrect a disposed session.
	 */
	dispose(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const record of this.#records.values()) {
			if (isActive(record.status)) {
				const binding = record.binding;
				if (binding !== undefined) stopBinding(binding);
			}
			this.#release(record, false);
		}
		this.#records.clear();
		this.#listeners.clear();
	}

	#assertOpen(): void {
		if (this.#closed) throw new TaskRegistryClosedError();
	}

	#nextId(type: string): { id: string; shortId: string } {
		const next = (this.#counters.get(type) ?? 0) + 1;
		this.#counters.set(type, next);
		const shortId = `${type}-${next}`;
		return { id: `${type}-${this.#discriminator}-${next}`, shortId };
	}

	#snapshot(record: TaskRecord): TaskSnapshot {
		return {
			id: record.id,
			shortId: record.shortId,
			type: record.type,
			status: record.status,
			purpose: record.purpose,
			startedAt: record.startedAt,
			...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
			...(record.delivery === undefined ? {} : { delivery: record.delivery }),
		};
	}

	#outcome(record: TaskRecord, waited: boolean): TaskWaitOutcomeSettled {
		const bounded = this.#bounded(record);
		return {
			id: record.id,
			status: record.status,
			waited,
			truncated: bounded.truncated,
			output: bounded.output,
			...(record.delivery === undefined ? {} : { delivery: record.delivery }),
			...(record.terminal?.structured === undefined
				? {}
				: { structured: record.terminal.structured }),
		};
	}

	#bounded(record: TaskRecord): TaskProgress {
		if (record.terminal !== undefined) return boundedOutput(record.terminal.output);
		let progress: TaskProgress = { output: "", truncated: false };
		try {
			progress = record.binding?.describe() ?? progress;
		} catch {
			// A producer that cannot describe live work still reports its status.
		}
		return boundedOutput(progress.output);
	}

	#settle(record: TaskRecord, terminal: TaskTerminal): void {
		record.status = terminal.status;
		record.endedAt = Date.now();
		record.terminal = terminal;
		record.delivery = "pending";
		this.#emit(record);
		this.#release(record, true);
		this.#evict();
	}

	#emit(record: TaskRecord): void {
		const terminal = record.terminal;
		if (terminal === undefined) return;
		const event = terminalEvent(record, terminal);
		for (const listener of [...this.#listeners]) {
			try {
				listener(event);
			} catch {
				// A failing consumer must not break settling or other consumers.
			}
		}
	}

	#release(record: TaskRecord, waited: boolean): void {
		const waiters = record.waiters;
		record.waiters = [];
		for (const waiter of waiters) waiter(waited);
	}

	#evict(): void {
		// Only results that still need notification are protected: they are bounded by the
		// admission budget, so a submitted or observed record can age out normally.
		const candidates = [...this.#records.values()].filter(
			(record) => !isActive(record.status) && record.delivery !== "pending",
		);
		for (const record of candidates.slice(0, Math.max(0, candidates.length - this.#maxRetained))) {
			this.#records.delete(record.id);
		}
	}

	#waitFor(record: TaskRecord, signal: AbortSignal | undefined): Promise<boolean> {
		if (!isActive(record.status)) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			const cleanup = (): void => {
				const index = record.waiters.indexOf(waiter);
				if (index >= 0) record.waiters.splice(index, 1);
				signal?.removeEventListener("abort", onAbort);
			};
			const waiter = (settled: boolean): void => {
				cleanup();
				resolve(settled);
			};
			const onAbort = (): void => {
				cleanup();
				resolve(false);
			};
			record.waiters.push(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted === true) onAbort();
		});
	}
}

/** Typed Service key for the session's task registry. */
export const TASK_REGISTRY_SERVICE_KEY: ServiceKey<TaskRegistry> = createServiceKey<TaskRegistry>(
	"pi-ext-core:task-registry",
);

function isActive(status: TaskStatus): boolean {
	return status === "queued" || status === "starting" || status === "running";
}
function stopBinding(binding: TaskBinding): void {
	try {
		binding.stop();
	} catch {
		// Cancellation is best effort at this boundary; the producer reports real failures.
	}
}

function uniqueIds(ids: readonly string[]): string[] {
	return [...new Set(ids)];
}
