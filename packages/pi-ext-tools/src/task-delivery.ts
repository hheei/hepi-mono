import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	errorMessage,
	getBackgroundDelivery,
	isRecord,
	type TaskRegistry,
	type TaskTerminalEvent,
} from "@hheei/pi-ext-core";

export interface TaskReminder {
	readonly kind: "idle" | "heartbeat";
	readonly anchor?: string | undefined;
	readonly job: {
		readonly id: string;
		readonly status: string;
		readonly startedAt: number;
		readonly output: string;
		readonly logPath?: string | undefined;
	};
}

export interface TaskReminderSource {
	get(id: string): { readonly status: string } | undefined;
	onReminder(listener: (event: TaskReminder) => void): () => void;
}

/** Custom message type used for one terminal notification per task. */
export const TASK_TERMINAL_CUSTOM_TYPE = "bg-bash-report";
/** Bounded output kept per task inside one notification. */
export const MAX_TASK_MESSAGE_CHARS = 10_000;
/**
 * Bounded aggregate size of one notification in UTF-8 bytes; larger batches are split. The unit is
 * bytes because that is what the message costs once it reaches the model, and non-ASCII content
 * costs more than one byte per character. Each entry's own text is capped at
 * `MAX_TASK_MESSAGE_CHARS` characters, which is well below this bound, so a single result can never
 * exceed it — the split only has to decide where to break a set of results.
 */
export const MAX_NOTIFICATION_BATCH_BYTES = 24_000;
/** Bounded number of results in one notification; a long list of small results is split too. */
export const MAX_NOTIFICATION_BATCH_ENTRIES = 8;

/** The aggregate bound is stated in bytes, and a JSON string's length is UTF-16 code units. */
function byteSize(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

export interface TaskDeliveryOptions {
	readonly pi: ExtensionAPI;
	readonly registry: TaskRegistry;
	readonly reminderSource?: TaskReminderSource | undefined;
	/** Backward-compatible alias for reminderSource. */
	readonly jobs?: TaskReminderSource | undefined;
	/** Session context captured at lifecycle start; reads parent idleness and the current branch. */
	readonly session: ExtensionContext;
	readonly signal?: AbortSignal;
	readonly notify: (message: string, level: "info" | "warning") => void;
}

/**
 * Owns parent-session notification for terminal task results.
 *
 * Busy parents receive results in the next model step; idle parents wait for all background
 * work to finish. Bash reminders share the channel and may bypass that idle completion gate.
 *
 * Delivery is recorded in three states: `pending` (still reserved), `submitted` (handed to
 * the host, still unconfirmed) and `observed` (the host emitted the message lifecycle event).
 * A rejected submission is requeued and reported instead of being silently dropped or
 * retried without bound.
 */
export function startTaskDelivery(options: TaskDeliveryOptions): () => void {
	const { pi, registry, session, notify } = options;
	const reminderSource = options.reminderSource ?? options.jobs;
	const reported = new Set<string>();
	const held = new Set<string>();
	const reminders = new Map<string, TaskReminder>();
	let disposed = false;

	const readyReminders = (): TaskReminder[] => {
		for (const [id] of reminders) {
			const task = registry.get(id);
			if (task === undefined || reminderSource?.get(id)?.status !== "running") reminders.delete(id);
		}
		return [...reminders.values()].filter((event) => onCurrentBranch(session, event));
	};
	const flush = (triggerTurn: boolean, urgentOnly: boolean): void => {
		if (disposed) return;
		const notices = readyReminders();
		const pending = urgentOnly ? [] : registry.pendingDeliveries();
		const ready = pending.filter((event) => onCurrentBranch(session, event));
		const waitingElsewhere = pending.filter((event) => !onCurrentBranch(session, event));
		for (const [index, event] of notices.entries()) {
			const wake =
				triggerTurn && (!session.isIdle() || (ready.length === 0 && index === notices.length - 1));
			try {
				pi.sendMessage(
					{
						customType: TASK_TERMINAL_CUSTOM_TYPE,
						content: reminderText(event),
						display: true,
						details: { kind: event.kind, taskId: event.job.id },
					},
					{ deliverAs: "steer", triggerTurn: wake },
				);
				if (reminders.get(event.job.id) === event) reminders.delete(event.job.id);
			} catch (error) {
				notify(
					`Task reminder delivery failed for ${event.job.id}: ${errorMessage(error)}`,
					"warning",
				);
			}
		}
		// An id that is no longer pending — consumed, delivered, or evicted — must not
		// stay in this set, or it would both grow without bound and stay silent if it returned.
		for (const id of held) {
			if (!waitingElsewhere.some((event) => event.id === id)) held.delete(id);
		}
		if (ready.length > 0) {
			// These are delivered now, so a later hold on another branch must announce them again.
			for (const event of ready) held.delete(event.id);
			const batches = batchEvents(ready);
			for (const [index, batch] of batches.entries()) {
				submit(batch, triggerTurn && (!session.isIdle() || index === batches.length - 1));
			}
		}
		// Announced even when other results were delivered in this same check.
		announceHeld(waitingElsewhere);
	};

	/**
	 * A result that finished on another branch stays pending, so without this the user sees
	 * nothing at all until they navigate back. Each task is announced once.
	 */
	const announceHeld = (pending: readonly TaskTerminalEvent[]): void => {
		const waiting = pending.filter((event) => !held.has(event.id));
		if (waiting.length === 0) return;
		for (const event of waiting) held.add(event.id);
		const names = waiting.map((event) => event.shortId).join(", ");
		notify(
			`${waiting.length === 1 ? "A task result is" : `${waiting.length} task results are`} waiting on another branch: ${names}. Return to that branch to receive notification.`,
			"info",
		);
	};

	const submit = (events: readonly TaskTerminalEvent[], triggerTurn: boolean): void => {
		const batch = `task-batch-${crypto.randomUUID().slice(0, 8)}`;
		const ids = events.map((event) => event.id);
		const content = events.map(notificationText).join("\n\n");
		// Mark before sending so a synchronous message lifecycle event cannot observe a
		// record that still looks undelivered.
		registry.markSubmitted(ids, batch);
		try {
			pi.sendMessage(
				{
					customType: TASK_TERMINAL_CUSTOM_TYPE,
					content,
					display: true,
					details: {
						batch,
						tasks: events.map((event) => ({
							// Producer detail never shadows the registry's own fields: the task's status is the
							// status it reached, and a producer's reason for it stays a separate field.
							...event.detail,
							taskId: event.id,
							shortId: event.shortId,
							type: event.type,
							status: event.status,
							purpose: event.purpose,
							truncated: event.truncated,
						})),
					},
				},
				{ deliverAs: "steer", triggerTurn },
			);
		} catch (error) {
			registry.requeue(batch);
			for (const id of ids) {
				if (reported.has(id)) continue;
				reported.add(id);
				notify(`Task result delivery failed for ${id}: ${errorMessage(error)}`, "warning");
			}
		}
	};

	const unobserveMessage = pi.on("message_end", (event) => {
		const message: unknown = event.message;
		if (!isRecord(message) || message.role !== "custom") return;
		if (message.customType !== TASK_TERMINAL_CUSTOM_TYPE) return;
		const details = message.details;
		if (!isRecord(details) || typeof details.batch !== "string") return;
		registry.markObserved(details.batch);
	});
	const delivery = getBackgroundDelivery(pi);
	const unregisterSource = delivery.registerSource({
		activeCount: () => registry.activeCount,
		onChange: (listener) => registry.onTerminal(listener),
	});
	const channel = delivery.registerChannel({
		isIdle: () => session.isIdle(),
		hasPending: () =>
			!options.signal?.aborted &&
			(readyReminders().length > 0 ||
				registry.pendingDeliveries().some((event) => onCurrentBranch(session, event))),
		flush,
	});
	const schedule = (): void => {
		if (disposed) return;
		announceHeld(registry.pendingDeliveries().filter((event) => !onCurrentBranch(session, event)));
		channel.request(readyReminders().length > 0);
	};
	const unremind = reminderSource?.onReminder((event) => {
		if (disposed || options.signal?.aborted) return;
		reminders.set(event.job.id, event);
		channel.request(true);
	});
	const unsubscribe = registry.onTerminal(schedule);
	const unobserveStart = pi.on("agent_start", schedule);
	const unobserveSettled = pi.on("agent_settled", schedule);
	// Results that finished on another branch stay pending; returning to their branch must resume
	// their delivery instead of waiting for an unrelated task to finish.
	const unobserveTree = pi.on("session_tree", () => {
		if (
			readyReminders().length > 0 ||
			registry.pendingDeliveries().some((event) => onCurrentBranch(session, event))
		)
			schedule();
	});

	return () => {
		disposed = true;
		reminders.clear();
		unremind?.();
		channel.dispose();
		unregisterSource();
		unsubscribe();
		unobserveStart();
		unobserveSettled();
		unobserveMessage();
		unobserveTree();
	};
}

/** True when the task's starting point is still an ancestor of the current branch. */
function onCurrentBranch(
	session: ExtensionContext,
	event: { readonly anchor?: string | undefined },
): boolean {
	if (event.anchor === undefined) return true;
	try {
		return session.sessionManager.getBranch().some((entry) => entry.id === event.anchor);
	} catch {
		// Without a readable branch, keep anchored results pending until it is available.
		return false;
	}
}

function reminderText(event: TaskReminder): string {
	const { job, kind } = event;
	const elapsed = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000));
	const reason =
		kind === "idle" ? `idle for ${elapsed}s without output` : `still running (${elapsed}s)`;
	const header = `[${job.id}: ${reason}]`;
	const lines = [header];
	if (job.logPath !== undefined) {
		lines.push(`log: ${job.logPath}`);
	}
	const tail = job.output.slice(-2000).trim();
	if (tail !== "") {
		lines.push(tail);
	}
	return lines.join("\n");
}

function notificationText(event: TaskTerminalEvent): string {
	const detail = isRecord(event.detail) ? event.detail : undefined;
	const exitCode = typeof detail?.exitCode === "number" ? detail.exitCode : undefined;
	const logPath = typeof detail?.logPath === "string" ? detail.logPath : undefined;

	let statusLabel: string;
	if (event.status === "timed_out") {
		statusLabel = "timed out";
	} else if (event.status === "cancelled") {
		statusLabel = "stopped";
	} else if (exitCode !== undefined) {
		statusLabel = `exit ${exitCode}`;
	} else {
		statusLabel = event.status;
	}

	const header = `[${event.id}: ${event.purpose} · ${statusLabel}]`;
	const lines = [header];

	const rawOutput = event.output ? event.output.trimEnd() : "";
	if (rawOutput !== "") {
		if (event.structured !== undefined && rawOutput.length > MAX_TASK_MESSAGE_CHARS) {
			lines.push(`structured result (${rawOutput.length} chars) too large to inline`);
		} else if (rawOutput.length > MAX_TASK_MESSAGE_CHARS) {
			const tail = rawOutput.slice(-MAX_TASK_MESSAGE_CHARS).trimStart();
			lines.push(`… (earlier output omitted)\n${tail}`);
		} else {
			lines.push(rawOutput);
		}
	}

	if (event.status === "timed_out") {
		lines.push(logPath ? `Command timed out (log: ${logPath})` : "Command timed out");
	} else if (event.status === "cancelled") {
		lines.push(logPath ? `Command stopped (log: ${logPath})` : "Command stopped");
	} else if (exitCode !== undefined && exitCode !== 0) {
		lines.push(
			logPath
				? `Command failed with exit code ${exitCode} (log: ${logPath})`
				: `Command failed with exit code ${exitCode}`,
		);
	} else if (logPath && (rawOutput.length > MAX_TASK_MESSAGE_CHARS || event.truncated)) {
		lines.push(`Full log: ${logPath}`);
	}

	return lines.join("\n");
}

/**
 * Splits ready results so one merged message stays inside the aggregate bound.
 */
function batchEvents(events: readonly TaskTerminalEvent[]): TaskTerminalEvent[][] {
	const batches: TaskTerminalEvent[][] = [];
	let batch: TaskTerminalEvent[] = [];
	let size = 0;
	for (const event of events) {
		const cost = byteSize(notificationText(event)) + 2;
		if (
			batch.length > 0 &&
			(size + cost > MAX_NOTIFICATION_BATCH_BYTES || batch.length >= MAX_NOTIFICATION_BATCH_ENTRIES)
		) {
			batches.push(batch);
			batch = [];
			size = 0;
		}
		batch.push(event);
		size += cost;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}
