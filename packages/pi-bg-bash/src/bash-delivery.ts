import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage, getBackgroundDelivery, isRecord } from "@hheei/pi-ext-core";
import type { BashJobRegistry, BashJobReminder, BashTerminalEvent } from "./bash-jobs.js";
import { appendBashInfo } from "./info.js";

/** Custom message type used for one Bash notification per batch. */
export const BASH_TERMINAL_CUSTOM_TYPE = "bg-bash-report";
/** Bounded inline output kept per job inside one notification, in characters. */
export const MAX_BASH_MESSAGE_CHARS = 10_000;
/**
 * Bounded size of one notification in UTF-8 bytes, because that is what the message costs once it
 * reaches the model. A single entry can carry multi-byte characters, so its inline output is cut to
 * the bytes the message has left after the header and trailer, at a UTF-8 boundary, and the complete
 * output stays reachable through the log path the entry always carries.
 */
export const MAX_NOTIFICATION_BATCH_BYTES = 24_000;
/** Bounded number of results in one notification; a long list of small results is split too. */
export const MAX_NOTIFICATION_BATCH_ENTRIES = 8;
/** Two bytes of `\n\n` join each entry to the previous one inside a message. */
const ENTRY_JOIN_BYTES = 2;
/** Marker kept when the inline output had to be cut. */
const OMITTED_MARKER = "… (earlier output omitted)";

function byteSize(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** The last `maxBytes` UTF-8 bytes of `text`, starting on a whole character. */
function tailBytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= maxBytes) return text;
	let start = bytes.byteLength - maxBytes;
	while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
	return bytes.subarray(start).toString("utf8");
}

/** The last `maxChars` characters, without splitting a surrogate pair. */
function tailChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const tail = text.slice(-maxChars);
	// A cut between a surrogate pair would encode as U+FFFD, so drop the orphaned low surrogate.
	return /[\udc00-\udfff]/u.test(tail[0] ?? "") ? tail.slice(1) : tail;
}

export interface BashDeliveryOptions {
	readonly pi: ExtensionAPI;
	readonly jobs: BashJobRegistry;
	/** Session context captured at lifecycle start; reads parent idleness and the current branch. */
	readonly session: ExtensionContext;
	readonly signal?: AbortSignal;
	readonly notify: (message: string, level: "info" | "warning") => void;
}

/**
 * Owns parent-session notification for terminal Bash results and Bash reminders.
 *
 * Busy parents receive results in their next model step; an idle parent is woken at most once per
 * batch by the delivery coordinator. Reminders share the channel and never enter the terminal
 * delivery state machine.
 *
 * Terminal delivery is recorded in the registry in three states: `pending` (still reserved),
 * `submitted` (handed to the host, still unconfirmed) and `recorded` (the host appended the message
 * lifecycle event). A rejected submission is requeued and reported instead of being silently
 * dropped or retried without bound.
 */
export function startBashDelivery(options: BashDeliveryOptions): () => void {
	const { pi, jobs, session, notify } = options;
	const reported = new Set<string>();
	const held = new Set<string>();
	const reminders = new Map<string, BashJobReminder>();
	let disposed = false;

	const readyReminders = (): BashJobReminder[] => {
		for (const [id] of reminders) {
			const job = jobs.get(id);
			// A job that stopped must not deliver a queued idle notice: its result is what matters now.
			if (job === undefined || job.status !== "running") reminders.delete(id);
		}
		return [...reminders.values()].filter((event) => onCurrentBranch(session, event));
	};

	const flush = (triggerTurn: boolean): void => {
		if (disposed) return;
		const notices = readyReminders();
		const pending = jobs.pendingDeliveries();
		const ready = pending.filter((event) => onCurrentBranch(session, event));
		const waitingElsewhere = pending.filter((event) => !onCurrentBranch(session, event));
		for (const [index, event] of notices.entries()) {
			const wake =
				triggerTurn && (!session.isIdle() || (ready.length === 0 && index === notices.length - 1));
			try {
				pi.sendMessage(
					{
						customType: BASH_TERMINAL_CUSTOM_TYPE,
						content: reminderText(event),
						display: false,
						details: { kind: event.kind, jobId: event.job.id },
					},
					{ deliverAs: "steer", triggerTurn: wake },
				);
				if (reminders.get(event.job.id) === event) reminders.delete(event.job.id);
				try {
					appendBashInfo(pi, event, reminderText(event));
				} catch (error) {
					notify(
						`Background Bash reminder UI entry failed for ${event.job.id}: ${errorMessage(error)}`,
						"warning",
					);
				}
			} catch (error) {
				notify(
					`Background Bash reminder delivery failed for ${event.job.id}: ${errorMessage(error)}`,
					"warning",
				);
			}
		}
		// An id that is no longer pending — delivered, consumed, or released — must not stay in this
		// set, or it would both grow without bound and stay silent if the same job came back.
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
	 * A result that finished on another branch stays pending, so without this the user sees nothing
	 * at all until they navigate back. Each job is announced once.
	 */
	const announceHeld = (waitingElsewhere: readonly BashTerminalEvent[]): void => {
		const waiting = waitingElsewhere.filter((event) => !held.has(event.id));
		if (waiting.length === 0) return;
		for (const event of waiting) held.add(event.id);
		const names = waiting.map((event) => event.id).join(", ");
		notify(
			`${waiting.length === 1 ? "A Bash result is" : `${waiting.length} Bash results are`} waiting on another branch: ${names}. Return to that branch to receive notification.`,
			"info",
		);
		for (const event of waiting) {
			try {
				appendBashInfo(
					pi,
					event,
					"Result waiting on another branch. Return to its original branch to receive output.",
					"held",
				);
			} catch (error) {
				notify(
					`Background Bash held-result UI entry failed for ${event.id}: ${errorMessage(error)}`,
					"warning",
				);
			}
		}
	};

	const submit = (events: readonly BashTerminalEvent[], triggerTurn: boolean): void => {
		const batch = `bash-batch-${crypto.randomUUID().slice(0, 8)}`;
		const ids = events.map((event) => event.id);
		const content = events.map(notificationText).join("\n\n");
		// Mark before sending so a synchronous message lifecycle event cannot observe a record that
		// still looks undelivered.
		jobs.markSubmitted(ids, batch);
		try {
			pi.sendMessage(
				{
					customType: BASH_TERMINAL_CUSTOM_TYPE,
					content,
					display: false,
					details: {
						batch,
						jobs: events.map((event) => ({
							jobId: event.id,
							purpose: event.purpose,
							status: event.status,
							exitCode: event.exitCode,
							truncated: event.truncated,
							...(event.logPath === undefined ? {} : { logPath: event.logPath }),
						})),
					},
				},
				{ deliverAs: "steer", triggerTurn },
			);
			for (const event of events) {
				try {
					appendBashInfo(pi, event, notificationText(event));
				} catch (error) {
					notify(
						`Background Bash UI entry failed for ${event.id}: ${errorMessage(error)}`,
						"warning",
					);
				}
			}
		} catch (error) {
			jobs.requeue(batch);
			for (const id of ids) {
				if (reported.has(id)) continue;
				reported.add(id);
				notify(
					`Background Bash result delivery failed for ${id}: ${errorMessage(error)}`,
					"warning",
				);
			}
		}
	};

	const unobserveMessage = pi.on("message_end", (event) => {
		const message: unknown = event.message;
		if (!isRecord(message) || message.role !== "custom") return;
		if (message.customType !== BASH_TERMINAL_CUSTOM_TYPE) return;
		const details = message.details;
		if (!isRecord(details) || typeof details.batch !== "string") return;
		jobs.markRecorded(details.batch);
	});

	const channel = getBackgroundDelivery(pi).registerChannel({
		isIdle: () => session.isIdle(),
		hasPending: () =>
			!options.signal?.aborted &&
			(readyReminders().length > 0 ||
				jobs.pendingDeliveries().some((event) => onCurrentBranch(session, event))),
		flush,
	});
	const reconcile = (branchChanged = false): void => {
		const receipts = branchReceipts(session);
		if (receipts !== undefined) jobs.reconcileRecorded(receipts, branchChanged);
	};
	const schedule = (): void => {
		if (disposed || options.signal?.aborted) return;
		reconcile();
		announceHeld(jobs.pendingDeliveries().filter((event) => !onCurrentBranch(session, event)));
		channel.request();
	};
	// A reminder is kept even when its branch is not current, so returning to that branch still
	// delivers the notice the job produced while it was away. A job that stopped before the notice
	// went out is dropped here, so its terminal result is what the parent receives.
	const unremind = jobs.onReminder((event) => {
		if (disposed || options.signal?.aborted) return;
		const job = jobs.get(event.job.id);
		if (job === undefined || job.status !== "running") return;
		reminders.set(event.job.id, event);
		channel.request();
	});
	const unsubscribe = jobs.onTerminal(schedule);
	const unobserveStart = pi.on("agent_start", schedule);
	const unobserveSettled = pi.on("agent_settled", schedule);
	// Results that finished on another branch stay pending; returning to their branch must resume
	// their delivery instead of waiting for an unrelated job to finish.
	const unobserveTree = pi.on("session_tree", () => {
		if (disposed || options.signal?.aborted) return;
		reconcile(true);
		schedule();
	});
	schedule();

	return () => {
		disposed = true;
		reminders.clear();
		unremind();
		channel.dispose();
		unsubscribe();
		unobserveStart();
		unobserveSettled();
		unobserveMessage();
		unobserveTree();
	};
}

/** Raw branch ancestry retains report receipts even when their content has been compacted. */
function branchReceipts(session: ExtensionContext): ReadonlySet<string> | undefined {
	try {
		const ids = new Set<string>();
		for (const entry of session.sessionManager.getBranch()) {
			if (entry.type !== "custom_message" || entry.customType !== BASH_TERMINAL_CUSTOM_TYPE)
				continue;
			const details: unknown = entry.details;
			if (!isRecord(details) || !Array.isArray(details.jobs)) continue;
			for (const job of details.jobs) {
				if (isRecord(job) && typeof job.jobId === "string") ids.add(job.jobId);
			}
		}
		return ids;
	} catch {
		return undefined;
	}
}

/** True when the job's starting point is still an ancestor of the current branch. */
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

function reminderText(event: BashJobReminder): string {
	const { job, kind } = event;
	const elapsed = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000));
	const reason =
		kind === "idle" ? `idle for ${elapsed}s without output` : `still running (${elapsed}s)`;
	const lines = [`[${job.id}: ${reason}]`];
	if (job.logPath !== undefined) lines.push(`log: ${job.logPath}`);
	// Cut the character count before the byte cut, so a surrogate pair is never opened.
	const tail = tailBytes(tailChars(job.output, 2000).trim(), 8_000);
	if (tail !== "") lines.push(tail);
	return lines.join("\n");
}

function statusLabel(event: BashTerminalEvent): string {
	if (event.status === "unknown") return "unknown outcome";
	if (event.status === "timed_out") return "timed out";
	if (event.status === "cancelled") return "stopped";
	if (event.exitCode !== null) return `exit ${String(event.exitCode)}`;
	return event.status;
}

/** The lines that follow the output: why it ended, where the whole thing is, and log problems. */
function trailerLines(event: BashTerminalEvent): string[] {
	const lines: string[] = [];
	if (event.status === "unknown") {
		lines.push(
			"Command outcome unknown. Execution was not resumed or rerun. Check side effects before deciding next action. Log may be incomplete.",
		);
	} else if (event.status === "timed_out") {
		lines.push(event.logPath ? `Command timed out (log: ${event.logPath})` : "Command timed out");
	} else if (event.status === "cancelled") {
		lines.push(event.logPath ? `Command stopped (log: ${event.logPath})` : "Command stopped");
	} else if (event.exitCode !== null && event.exitCode !== 0) {
		lines.push(
			event.logPath
				? `Command failed with exit code ${String(event.exitCode)} (log: ${event.logPath})`
				: `Command failed with exit code ${String(event.exitCode)}`,
		);
	}
	if (event.diagnostic !== undefined) lines.push(event.diagnostic);
	if (event.logPath !== undefined)
		lines.push(
			`${event.status === "unknown" ? "Available log (may be incomplete)" : "Full log"}: ${event.logPath}`,
		);
	if (event.logError !== undefined) lines.push(`Log file unavailable: ${event.logError}`);
	return lines;
}

/**
 * One entry of a notification. The header, trailer and the cut marker are reserved first, so the
 * inline output only gets the bytes that are left and the assembled entry stays inside the bound it
 * promises. The complete output is always reachable through the log path.
 */
function notificationText(event: BashTerminalEvent): string {
	const header = `[${event.id}: ${event.purpose} · ${statusLabel(event)}]`;
	const trailer = trailerLines(event);
	const fixed = byteSize(header) + byteSize(trailer.join("\n")) + trailer.length + 2;
	const budget = MAX_NOTIFICATION_BATCH_BYTES - ENTRY_JOIN_BYTES - fixed - byteSize(OMITTED_MARKER);
	const body = event.output.trimEnd();
	const lines = [header];
	if (body !== "") {
		const inline = tailBytes(tailChars(body, MAX_BASH_MESSAGE_CHARS), budget);
		if (inline === "") lines.push("Output too large to inline");
		else if (byteSize(inline) < byteSize(body)) lines.push(`${OMITTED_MARKER}\n${inline}`);
		else lines.push(body);
	}
	lines.push(...trailer);
	return lines.join("\n");
}

/** Splits ready results so one merged message stays inside the aggregate bound. */
function batchEvents(events: readonly BashTerminalEvent[]): BashTerminalEvent[][] {
	const batches: BashTerminalEvent[][] = [];
	let batch: BashTerminalEvent[] = [];
	let size = 0;
	for (const event of events) {
		const cost = byteSize(notificationText(event)) + ENTRY_JOIN_BYTES;
		if (batch.length > 0 && size + cost > MAX_NOTIFICATION_BATCH_BYTES) {
			batches.push(batch);
			batch = [];
			size = 0;
		}
		batch.push(event);
		size += cost;
		if (batch.length >= MAX_NOTIFICATION_BATCH_ENTRIES) {
			batches.push(batch);
			batch = [];
			size = 0;
		}
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}
