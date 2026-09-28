/**
 * Agent Task producer.
 *
 * One `task` call becomes one entry in the shared background-task registry and one dedicated
 * child process. The child is not a reusable conversation partner: it runs, submits exactly one
 * final result, and is then terminated, so a Task can never be served by a stale execution and a
 * finished Task can never be quietly revived.
 *
 * The producer keeps execution control (it owns launching, stopping and cleanup) and reports
 * only state transitions and one terminal result to the registry.
 */
import {
	errorMessage,
	isRecord,
	isTerminalTaskStatus,
	type TaskBinding,
	type TaskProgress,
	type TaskRegistry,
	type TaskSnapshot,
	type TaskTerminal,
} from "@hheei/pi-ext-core";
import type { TaskChildContract } from "./domain.js";
import { isTaskResultPayload, TASK_RESULT_EVENT } from "./protocol.js";

/** Live Task children allowed at once; the rest wait in the queue. */
export const DEFAULT_MAX_TASK_EXECUTIONS = 4;

/** Bounded waiting room. A full queue is reported to the caller instead of growing. */
export const DEFAULT_MAX_QUEUED_TASKS = 32;

/** One-line intent shown to the model, the user and terminal deliveries. */
const MAX_PURPOSE_CHARS = 200;

/**
 * Child events held while their execution is still being launched. Launch resolves only after the
 * child acknowledged its initial prompt, so a fast child can submit and settle before the producer
 * knows its child id; dropping those events would leave the Task running forever.
 *
 * The buffer is per child, because concurrent launches share it: one chatty child must not be able
 * to push another child's settlement out of a single queue. Inside one child's share the events that
 * decide the Task are kept last, so turn traffic can never displace a submission or a settlement.
 * The total is bounded by the number of children that can be in flight at once, which is the agent
 * concurrency limit.
 */
const MAX_HELD_EVENTS = 64;
const MAX_HELD_CHILDREN = 8;

export interface AgentTaskRequest {
	readonly agent: string;
	readonly task: string;
	readonly cwd?: string;
	/** True for a blocking call, whose caller reports the result inline. */
	readonly inlineResult?: boolean;
	readonly contract: TaskChildContract;
	/** Branch marker captured at admission; the delivery adapter decides where it may land. */
	readonly anchor?: string;
}

export interface AgentTaskChild {
	/**
	 * Dedicated child of this Task. A Task child is never resumed, so the id also identifies the
	 * one execution that may settle it.
	 */
	readonly childId: string;
}

export class AgentTaskQueueError extends Error {
	readonly limit: number;

	public constructor(limit: number) {
		super(`Task queue is full (${limit} waiting); wait for running tasks to finish`);
		this.name = "AgentTaskQueueError";
		this.limit = limit;
	}
}

export interface AgentTaskExecutorDeps {
	readonly registry: TaskRegistry;
	/** Launches the dedicated child for one accepted Task. */
	readonly launch: (request: AgentTaskRequest) => Promise<AgentTaskChild>;
	/** True only when the runner exit was confirmed; a failed stop stays visible instead. */
	readonly stopChild: (childId: string) => Promise<boolean>;
	/**
	 * Called when a child could not be confirmed gone. Its concurrency slot stays occupied and
	 * the Task stays un-settled, so this is a real condition the user should see.
	 */
	readonly onCleanupFailure?: (childId: string, reason: string) => void;
	readonly maxRunning?: number;
	readonly maxQueued?: number;
}

type JobPhase = "queued" | "starting" | "running" | "stopping";

interface TaskJob {
	/** Assigned by the registry at admission, before the first phase transition. */
	id: string;
	readonly request: AgentTaskRequest;
	phase: JobPhase;
	child: AgentTaskChild | undefined;
	/** Set once the child submitted a validated final result. */
	candidate: { readonly json: string; readonly structured: boolean } | undefined;
	output: string;
}

export class AgentTaskExecutor {
	readonly #deps: AgentTaskExecutorDeps;
	readonly #jobs = new Map<string, TaskJob>();
	readonly #queue: string[] = [];
	readonly #held = new Map<string, unknown[]>();
	/** Ids whose child is being torn down right now, so cleanup is not started twice. */
	readonly #terminating = new Set<string>();
	#disposed = false;

	public constructor(deps: AgentTaskExecutorDeps) {
		this.#deps = deps;
	}

	/**
	 * Live executions. A job whose runner exit is not yet confirmed is still in `#jobs`, so its
	 * slot is already counted here; adding it again would make one failed stop consume two slots.
	 */
	get running(): number {
		return this.#jobs.size - this.#queue.length;
	}

	get queued(): number {
		return this.#queue.length;
	}

	/**
	 * Admits one Task. Admission is where capacity is decided: a full registry or a full queue
	 * is reported now rather than discovered after the work already started.
	 */
	public start(request: AgentTaskRequest): TaskSnapshot {
		if (this.#disposed) throw new Error("Task executor is closed");
		const maxQueued = this.#deps.maxQueued ?? DEFAULT_MAX_QUEUED_TASKS;
		if (this.#queue.length >= maxQueued) throw new AgentTaskQueueError(maxQueued);
		const job: TaskJob = {
			id: "",
			request,
			phase: "queued",
			child: undefined,
			candidate: undefined,
			output: "queued",
		};
		const snapshot = this.#deps.registry.create({
			type: "agent",
			purpose: purposeOf(request),
			initialStatus: "queued",
			...(request.anchor === undefined ? {} : { anchor: request.anchor }),
			// A blocking `task` call returns the result itself, so it must not also reserve a
			// notification for the same outcome.
			...(request.inlineResult === undefined ? {} : { inlineResult: request.inlineResult }),
			begin: (id) => this.#binding(job, id),
		});
		job.id = snapshot.id;
		this.#jobs.set(snapshot.id, job);
		this.#queue.push(snapshot.id);
		this.#drain();
		return snapshot;
	}

	/**
	 * Handles one runner event of one child. Events are only delivered for the currently attached
	 * runner of a child, and a Task child is never resumed, so the child id identifies exactly one
	 * execution: a stale or foreign result cannot settle a Task that already moved on.
	 */
	public handleChildEvent(childId: string, event: unknown): void {
		if (!isRecord(event)) return;
		const entry = this.#entryForChild(childId);
		if (entry === undefined) {
			this.#holdForStartingJob(childId, event);
			return;
		}
		const [id, job] = entry;
		if (event.type === TASK_RESULT_EVENT) {
			// Runner events cross a process boundary, so the payload is validated here rather than
			// trusted from its declared type.
			if (!isTaskResultPayload(event)) return;
			if (event.childId !== childId) return;
			job.candidate = { json: event.json, structured: event.structured };
			job.output = "final result submitted";
			return;
		}
		if (event.type === "agent_settled") void this.#observeSettle(id, job);
	}

	/** Requests cancellation. A running Task only ends once its child's exit is confirmed. */
	public stop(id: string): void {
		const job = this.#jobs.get(id);
		if (job === undefined) return;
		if (job.phase === "queued") {
			// A queued Task never starts a process, so cancellation is already complete.
			const index = this.#queue.indexOf(id);
			if (index !== -1) this.#queue.splice(index, 1);
			job.phase = "stopping";
			this.#settle(id, { status: "cancelled", output: "cancelled before start", truncated: false });
			this.#drain();
			return;
		}
		if (job.phase === "starting") {
			// The launch is already in flight and nobody else will own the process it may produce, so
			// the job keeps its slot and the launch continuation performs the cleanup.
			job.phase = "stopping";
			job.output = "stop requested";
			return;
		}
		if (this.#terminating.has(id)) return;
		job.phase = "stopping";
		job.output = "stop requested";
		void this.#terminate(id, job, this.#stopTerminal(job));
	}

	/** Ends every remaining execution. Used when the owning session goes away. */
	public dispose(): void {
		this.#disposed = true;
		this.#queue.length = 0;
		for (const job of [...this.#jobs.values()]) {
			if (job.phase === "queued") {
				this.#settle(job.id, { status: "cancelled", output: "session ended", truncated: false });
				continue;
			}
			if (job.phase === "starting") {
				// An in-flight launch still owns the cleanup of the process it may produce.
				job.phase = "stopping";
				job.output = "session ended";
				continue;
			}
			job.phase = "stopping";
			void this.#terminate(job.id, job, {
				status: "cancelled",
				output: "session ended",
				truncated: false,
			});
		}
	}

	/** Read through a call so a phase change during an await is not narrowed away. */
	#isStopping(job: TaskJob): boolean {
		return job.phase === "stopping";
	}

	/**
	 * Holds one event of a child whose job is not known yet. Only a starting job can still claim
	 * it, and a Task child is never resumed, so a held event either finds its job or is dropped.
	 */
	#holdForStartingJob(childId: string, event: unknown): void {
		let starting = false;
		for (const job of this.#jobs.values()) {
			if (job.phase === "starting") {
				starting = true;
				break;
			}
		}
		if (!starting) return;
		const events = this.#held.get(childId) ?? [];
		events.push(event);
		if (events.length > MAX_HELD_EVENTS) {
			// Within one child the disposable events go first, so a submission or a settlement
			// survives a long run of turn events.
			const disposable = events.findIndex((held) => !isSettlementEvent(held));
			events.splice(disposable === -1 ? 0 : disposable, 1);
		}
		this.#held.set(childId, events);
		// A child id we can no longer attribute can only come from a launch in flight, so buckets are
		// few; the oldest one goes first if more appear than that.
		while (this.#held.size > MAX_HELD_CHILDREN) {
			const oldest = this.#held.keys().next();
			if (oldest.done === true) return;
			this.#held.delete(oldest.value);
		}
	}

	/** Replays the events that arrived before this child could be attributed to its job. */
	#replayHeld(childId: string): void {
		const events = this.#held.get(childId);
		if (events === undefined) return;
		this.#held.delete(childId);
		for (const event of events) this.handleChildEvent(childId, event);
	}

	/**
	 * The terminal state of a stop request. A validated submission that already arrived is real work
	 * that was delivered, so a later stop must not report it as thrown away: whichever of the two
	 * paths settles first now records the same outcome.
	 */
	#stopTerminal(job: TaskJob): TaskTerminal {
		if (job.candidate === undefined) {
			return { status: "cancelled", output: "stopped", truncated: false };
		}
		return terminalFor(job.candidate, job.child?.childId);
	}

	#entryForChild(childId: string): [string, TaskJob] | undefined {
		for (const entry of this.#jobs) {
			if (entry[1].child?.childId === childId) return entry;
		}
		return undefined;
	}

	#binding(job: TaskJob, id: string): TaskBinding {
		return {
			stop: () => this.stop(id),
			describe: (): TaskProgress => ({ output: job.output, truncated: false }),
		};
	}

	#drain(): void {
		if (this.#disposed) return;
		const maxRunning = this.#deps.maxRunning ?? DEFAULT_MAX_TASK_EXECUTIONS;
		while (this.#queue.length > 0 && this.running < maxRunning) {
			const id = this.#queue.shift();
			if (id === undefined) break;
			const job = this.#jobs.get(id);
			if (job === undefined) continue;
			void this.#run(job);
		}
	}

	async #run(job: TaskJob): Promise<void> {
		job.phase = "starting";
		job.output = "starting child";
		this.#deps.registry.markStarting(job.id);
		let child: AgentTaskChild;
		try {
			child = await this.#deps.launch(job.request);
		} catch (error) {
			// A stop that arrived while the launch was failing is already honoured: nothing was
			// started, so the honest outcome is cancellation rather than a start failure.
			this.#settle(
				job.id,
				this.#isStopping(job)
					? { status: "cancelled", output: "stopped", truncated: false }
					: {
							status: "failed",
							output: `Task child failed to start: ${errorMessage(error)}`,
							truncated: false,
							detail: { stage: "launch", safeToRetry: true },
						},
			);
			this.#drain();
			return;
		}
		job.child = child;
		this.#replayHeld(child.childId);
		// A stop that arrived while the child was starting must clean up the late runner rather
		// than leave it running unobserved.
		if (this.#isStopping(job)) {
			void this.#terminate(job.id, job, this.#stopTerminal(job));
			return;
		}
		job.phase = "running";
		job.output = "running";
		this.#deps.registry.markRunning(job.id);
	}

	/**
	 * The child's execution reached a settled state with nothing more to do. Only a validated
	 * submission makes a Task completed; a settled execution without one is an explicit failure
	 * rather than another round of waking the child up.
	 */
	async #observeSettle(id: string, job: TaskJob): Promise<void> {
		const snapshot = this.#deps.registry.get(id);
		if (snapshot === undefined || isTerminalTaskStatus(snapshot.status)) return;
		if (job.candidate !== undefined) {
			await this.#terminate(id, job, terminalFor(job.candidate, job.child?.childId));
			return;
		}
		if (job.phase === "stopping") {
			// The execution ended because it was cancelled; report that, not a missing result.
			await this.#terminate(id, job, { status: "cancelled", output: "stopped", truncated: false });
			return;
		}
		await this.#terminate(id, job, {
			status: "failed",
			output:
				"The task child settled without submitting a final result. Re-run the task, or ask it to report a blocker instead of continuing.",
			truncated: false,
			detail: {
				reason: "invalid_result",
				...(job.child === undefined ? {} : { childId: job.child.childId }),
			},
		});
	}

	/**
	 * Cleans the child up and then records the terminal state. The concurrency slot is released
	 * only after the exit is confirmed; an unconfirmed exit keeps the Task observable.
	 */
	async #terminate(id: string, job: TaskJob, terminal: TaskTerminal): Promise<void> {
		// Cleanup is single flight: two paths may decide to end the same Task (a stop and a settled
		// execution), and both must describe the same outcome instead of racing the child.
		if (this.#terminating.has(id)) return;
		this.#terminating.add(id);
		try {
			const child = job.child;
			job.phase = "stopping";
			if (child === undefined) {
				this.#settle(id, terminal);
				return;
			}
			let confirmed = false;
			try {
				confirmed = await this.#deps.stopChild(child.childId);
			} catch (error) {
				this.#deps.onCleanupFailure?.(child.childId, errorMessage(error));
			}
			if (!confirmed) {
				// The slot stays occupied and the Task stays un-settled, so a later stop can try again.
				job.output = `${terminal.status}; runner exit is not confirmed`;
				this.#deps.onCleanupFailure?.(child.childId, "Runner termination was not confirmed");
				return;
			}
			this.#settle(id, terminal);
			this.#drain();
		} finally {
			this.#terminating.delete(id);
		}
	}

	#settle(id: string, terminal: TaskTerminal): void {
		if (!this.#deps.registry.settle(id, terminal)) return;
		this.#jobs.delete(id);
	}
}

/** Text result when no schema was requested; the output is exactly what the child submitted. */
function terminalFor(
	candidate: { readonly json: string; readonly structured: boolean },
	childId: string | undefined,
): TaskTerminal {
	return {
		status: "completed",
		output: candidate.json,
		truncated: false,
		detail: childId === undefined ? {} : { childId },
		...(candidate.structured ? { structured: JSON.parse(candidate.json) } : {}),
	};
}

/** The events that decide a Task: a final result, or the end of the execution that should have one. */
function isSettlementEvent(event: unknown): boolean {
	if (!isRecord(event)) return false;
	return event.type === TASK_RESULT_EVENT || event.type === "agent_settled";
}

function purposeOf(request: AgentTaskRequest): string {
	const line = request.task.trim().split("\n", 1)[0] ?? "";
	const clipped =
		line.length > MAX_PURPOSE_CHARS ? `${line.slice(0, MAX_PURPOSE_CHARS - 1)}…` : line;
	return `${request.agent}: ${clipped}`;
}
