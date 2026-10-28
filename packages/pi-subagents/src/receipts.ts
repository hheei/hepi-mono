import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openStateDb, withWrite } from "./state-db.js";

export type ReceiptStatus =
	| "reserved"
	| "dispatching"
	| "accepted"
	| "running"
	| "completed"
	| "blocked"
	| "failed"
	| "uncertain";

export type ReceiptDelivery = "pending" | "detached";

export interface Receipt {
	readonly parentSessionId: string;
	readonly delegationId: string;
	readonly childId?: string;
	readonly revision?: number;
	readonly task: string;
	readonly inputCheckpoint?: string;
	readonly runBoundary?: number;
	/** The compaction this delegation controls; set instead of a run boundary. */
	readonly controlId?: string;
	readonly status: ReceiptStatus;
	readonly delivery: ReceiptDelivery;
	readonly resultText?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface ReceiptSettlement {
	readonly childId: string;
	readonly status: "completed" | "blocked" | "failed";
	readonly message: string;
	/** The turn that can settle this event; absent for a control operation. */
	readonly workVersion?: number;
	/** Set for a control operation's own settlement; such a receipt has no run boundary. */
	readonly controlId?: string;
}

const TERMINAL: ReadonlySet<ReceiptStatus> = new Set([
	"completed",
	"blocked",
	"failed",
	"uncertain",
]);
const waiters = new Map<string, Set<() => void>>();

export function createDelegationId(): string {
	return `dep_${randomBytes(4).toString("hex")}`;
}

export function terminalReceipt(status: ReceiptStatus): boolean {
	return TERMINAL.has(status);
}

export function reserveReceipt(
	filePath: string,
	input: {
		readonly parentSessionId: string;
		readonly task: string;
		readonly childId?: string;
		readonly delivery: ReceiptDelivery;
	},
): Receipt {
	const db = openStateDb(filePath);
	const now = Date.now();
	const delegationId = createDelegationId();
	return withWrite(db, () => {
		const revision =
			input.childId === undefined ? null : nextRevision(db, input.parentSessionId, input.childId);
		db.prepare(
			`INSERT INTO delegations (
				parent_session_id, delegation_id, child_id, delegation_revision, task, status, delivery, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
		).run(
			input.parentSessionId,
			delegationId,
			input.childId ?? null,
			revision,
			input.task,
			input.delivery,
			now,
			now,
		);
		const stored = readReceipt(db, input.parentSessionId, delegationId);
		if (stored === undefined) throw new Error("Reserved delegation was not stored");
		return stored;
	});
}

export function updateReceipt(
	filePath: string,
	parentSessionId: string,
	delegationId: string,
	patch: {
		readonly from: readonly ReceiptStatus[];
		readonly status: ReceiptStatus;
		readonly childId?: string;
		readonly inputCheckpoint?: string;
		readonly runBoundary?: number;
		readonly controlId?: string;
		readonly resultText?: string;
	},
): Receipt | undefined {
	const db = openStateDb(filePath);
	const updated = withWrite(db, () => {
		const current = readReceipt(db, parentSessionId, delegationId);
		if (current === undefined || !patch.from.includes(current.status)) return undefined;
		const revision =
			current.revision ??
			(patch.childId === undefined ? null : nextRevision(db, parentSessionId, patch.childId));
		db.prepare(
			`UPDATE delegations
			 SET status = ?, child_id = COALESCE(?, child_id), input_checkpoint = COALESCE(?, input_checkpoint),
			     delegation_revision = COALESCE(?, delegation_revision), run_boundary = COALESCE(?, run_boundary),
			     control_id = COALESCE(?, control_id), result_text = COALESCE(?, result_text), updated_at = ?
			 WHERE parent_session_id = ? AND delegation_id = ? AND status = ?`,
		).run(
			patch.status,
			patch.childId ?? null,
			patch.inputCheckpoint ?? null,
			revision,
			patch.runBoundary ?? null,
			patch.controlId ?? null,
			patch.resultText ?? null,
			Date.now(),
			parentSessionId,
			delegationId,
			current.status,
		);
		return readReceipt(db, parentSessionId, delegationId);
	});
	notify(parentSessionId, delegationId);
	return updated;
}

/** A dispatch that died before acceptance cannot be retried safely. */
export function sweepUncertainDispatch(filePath: string, parentSessionId: string): number {
	const db = openStateDb(filePath);
	const changed = withWrite(db, () => {
		const rows = db
			.prepare(
				`SELECT delegation_id FROM delegations
				 WHERE parent_session_id = ? AND status = 'dispatching'`,
			)
			.all(parentSessionId) as Array<{ delegation_id: string }>;
		for (const row of rows) {
			db.prepare(
				`UPDATE delegations SET status = 'uncertain', result_text = ?, updated_at = ?
				 WHERE parent_session_id = ? AND delegation_id = ? AND status = 'dispatching'`,
			).run(
				"Dispatch was not acknowledged before the controller stopped",
				Date.now(),
				parentSessionId,
				row.delegation_id,
			);
			notify(parentSessionId, row.delegation_id);
		}
		return rows.length;
	});
	return changed;
}

export function settleReceipts(
	filePath: string,
	parentSessionId: string,
	event: ReceiptSettlement,
): readonly Receipt[] {
	const db = openStateDb(filePath);
	const settled = withWrite(db, () => {
		// A control operation is bound to its own id: a late compaction report cannot settle a turn
		// that started after it, and a turn's answer cannot be reported as a compaction.
		const rows = (
			event.controlId === undefined
				? db
						.prepare(
							`SELECT delegation_id FROM delegations
							 WHERE parent_session_id = ? AND child_id = ? AND run_boundary = ?
							   AND control_id IS NULL AND status IN ('accepted', 'running', 'dispatching')`,
						)
						.all(parentSessionId, event.childId, event.workVersion ?? 0)
				: db
						.prepare(
							`SELECT delegation_id FROM delegations
							 WHERE parent_session_id = ? AND child_id = ? AND control_id = ?
							   AND status IN ('accepted', 'running', 'dispatching')`,
						)
						.all(parentSessionId, event.childId, event.controlId)
		) as Array<{ delegation_id: string }>;
		const now = Date.now();
		const stored: Receipt[] = [];
		for (const row of rows) {
			db.prepare(
				`UPDATE delegations
				 SET status = ?, result_text = ?, run_boundary = COALESCE(?, run_boundary), updated_at = ?
				 WHERE parent_session_id = ? AND delegation_id = ? AND status IN ('accepted', 'running', 'dispatching')`,
			).run(
				event.status,
				event.message,
				event.controlId === undefined ? (event.workVersion ?? 0) : null,
				now,
				parentSessionId,
				row.delegation_id,
			);
			const receipt = readReceipt(db, parentSessionId, row.delegation_id);
			if (receipt !== undefined) stored.push(receipt);
		}
		return stored;
	});
	for (const receipt of settled) notify(receipt.parentSessionId, receipt.delegationId);
	return settled;
}

/**
 * A control operation that outlived the process that started it can never be confirmed: the child
 * may have compacted, may still be compacting, or may never have started. It is recorded as
 * uncertain instead of being replayed, because replaying compaction is not idempotent.
 */
export function sweepControlReceipts(
	filePath: string,
	parentSessionId: string,
	message: string,
): readonly Receipt[] {
	const db = openStateDb(filePath);
	const swept = withWrite(db, () => {
		const rows = db
			.prepare(
				`SELECT delegation_id FROM delegations
				 WHERE parent_session_id = ? AND control_id IS NOT NULL
				   AND status IN ('accepted', 'running')`,
			)
			.all(parentSessionId) as Array<{ delegation_id: string }>;
		const now = Date.now();
		const stored: Receipt[] = [];
		for (const row of rows) {
			db.prepare(
				`UPDATE delegations SET status = 'uncertain', result_text = ?, updated_at = ?
				 WHERE parent_session_id = ? AND delegation_id = ? AND status IN ('accepted', 'running')`,
			).run(message, now, parentSessionId, row.delegation_id);
			const receipt = readReceipt(db, parentSessionId, row.delegation_id);
			if (receipt !== undefined) stored.push(receipt);
		}
		return stored;
	});
	for (const receipt of swept) notify(receipt.parentSessionId, receipt.delegationId);
	return swept;
}

export function listReceipts(
	filePath: string,
	parentSessionId: string,
	cursor = 0,
	limit = 20,
): { readonly receipts: readonly Receipt[]; readonly nextCursor?: number } {
	const db = openStateDb(filePath);
	const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 20;
	const safeCursor = Number.isInteger(cursor) && cursor > 0 ? cursor : 0;
	const rows = db
		.prepare(
			`SELECT delegation_id FROM delegations
			 WHERE parent_session_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
		)
		.all(parentSessionId, safeLimit + 1, safeCursor) as Array<{ delegation_id: string }>;
	const receipts = rows.slice(0, safeLimit).flatMap((row) => {
		const receipt = readReceipt(db, parentSessionId, row.delegation_id);
		return receipt === undefined ? [] : [receipt];
	});
	return rows.length > safeLimit ? { receipts, nextCursor: safeCursor + safeLimit } : { receipts };
}

/** Stop or shutdown: every open delegation for this child fails, so a waiter cannot hang. */
export function abandonReceipts(
	filePath: string,
	parentSessionId: string,
	childId: string,
	message: string,
): readonly Receipt[] {
	const db = openStateDb(filePath);
	const abandoned = withWrite(db, () => {
		const rows = db
			.prepare(
				`SELECT delegation_id FROM delegations
				 WHERE parent_session_id = ? AND child_id = ?
				   AND status IN ('reserved', 'dispatching', 'accepted', 'running')`,
			)
			.all(parentSessionId, childId) as Array<{ delegation_id: string }>;
		const now = Date.now();
		const stored: Receipt[] = [];
		for (const row of rows) {
			db.prepare(
				`UPDATE delegations SET status = 'failed', result_text = ?, updated_at = ?
				 WHERE parent_session_id = ? AND delegation_id = ?
				   AND status IN ('reserved', 'dispatching', 'accepted', 'running')`,
			).run(message, now, parentSessionId, row.delegation_id);
			const receipt = readReceipt(db, parentSessionId, row.delegation_id);
			if (receipt !== undefined) stored.push(receipt);
		}
		return stored;
	});
	for (const receipt of abandoned) notify(receipt.parentSessionId, receipt.delegationId);
	return abandoned;
}

export function maxRunBoundary(filePath: string, parentSessionId: string, childId: string): number {
	const db = openStateDb(filePath);
	const row = db
		.prepare(
			`SELECT MAX(run_boundary) AS boundary FROM delegations
			 WHERE parent_session_id = ? AND child_id = ?`,
		)
		.get(parentSessionId, childId) as { boundary: number | null } | undefined;
	return row?.boundary ?? 0;
}

export function readStoredReceipt(
	filePath: string,
	parentSessionId: string,
	delegationId: string,
): Receipt | undefined {
	return readReceipt(openStateDb(filePath), parentSessionId, delegationId);
}

export function readReceiptRevision(
	filePath: string,
	parentSessionId: string,
	childId: string,
	revision: number,
): Receipt | undefined {
	const db = openStateDb(filePath);
	const row = db
		.prepare(
			"SELECT delegation_id FROM delegations WHERE parent_session_id = ? AND child_id = ? AND delegation_revision = ?",
		)
		.get(parentSessionId, childId, revision) as { delegation_id: string } | undefined;
	return row === undefined ? undefined : readReceipt(db, parentSessionId, row.delegation_id);
}

export function latestReceiptForChild(
	filePath: string,
	parentSessionId: string,
	childId: string,
): Receipt | undefined {
	const db = openStateDb(filePath);
	const row = db
		.prepare(
			`SELECT delegation_id FROM delegations
			 WHERE parent_session_id = ? AND child_id = ?
			 ORDER BY rowid DESC LIMIT 1`,
		)
		.get(parentSessionId, childId) as { delegation_id: string } | undefined;
	if (row === undefined) return undefined;
	return readReceipt(db, parentSessionId, row.delegation_id);
}

export function waitForReceipt(
	filePath: string,
	parentSessionId: string,
	delegationId: string,
	signal?: AbortSignal,
): Promise<Receipt> {
	const current = readStoredReceipt(filePath, parentSessionId, delegationId);
	if (current !== undefined && terminalReceipt(current.status)) return Promise.resolve(current);
	return new Promise((resolve, reject) => {
		const key = waiterKey(parentSessionId, delegationId);
		const wake = (): void => {
			const receipt = readStoredReceipt(filePath, parentSessionId, delegationId);
			if (receipt === undefined || !terminalReceipt(receipt.status)) return;
			finish();
			resolve(receipt);
		};
		const fail = (): void => {
			finish();
			reject(
				signal?.reason instanceof Error ? signal.reason : new Error("Delegation wait aborted"),
			);
		};
		const finish = (): void => {
			signal?.removeEventListener("abort", fail);
			const set = waiters.get(key);
			set?.delete(wake);
			if (set !== undefined && set.size === 0) waiters.delete(key);
		};
		const set = waiters.get(key) ?? new Set();
		set.add(wake);
		waiters.set(key, set);
		if (signal !== undefined) {
			if (signal.aborted) {
				fail();
				return;
			}
			signal.addEventListener("abort", fail, { once: true });
		}
		wake();
	});
}

function nextRevision(db: DatabaseSync, parentSessionId: string, childId: string): number {
	const row = db
		.prepare(
			"SELECT MAX(delegation_revision) AS revision FROM delegations WHERE parent_session_id = ? AND child_id = ?",
		)
		.get(parentSessionId, childId) as { revision: number | null };
	return (row.revision ?? 0) + 1;
}

function readReceipt(
	db: DatabaseSync,
	parentSessionId: string,
	delegationId: string,
): Receipt | undefined {
	const row = db
		.prepare(
			`SELECT delegation_id, child_id, delegation_revision, task, input_checkpoint, run_boundary, control_id, status, delivery, result_text, created_at, updated_at
			 FROM delegations WHERE parent_session_id = ? AND delegation_id = ?`,
		)
		.get(parentSessionId, delegationId) as
		| {
				delegation_id: string;
				child_id: string | null;
				delegation_revision: number | null;
				task: string;
				input_checkpoint: string | null;
				run_boundary: number | null;
				control_id: string | null;
				status: string;
				delivery: string;
				result_text: string | null;
				created_at: number;
				updated_at: number;
		  }
		| undefined;
	if (
		row === undefined ||
		!isStatus(row.status) ||
		(row.delivery !== "pending" && row.delivery !== "detached")
	) {
		return undefined;
	}
	return {
		parentSessionId,
		delegationId: row.delegation_id,
		task: row.task,
		status: row.status,
		delivery: row.delivery,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.child_id === null ? {} : { childId: row.child_id }),
		...(row.delegation_revision === null ? {} : { revision: row.delegation_revision }),
		...(row.input_checkpoint === null ? {} : { inputCheckpoint: row.input_checkpoint }),
		...(row.run_boundary === null ? {} : { runBoundary: row.run_boundary }),
		...(row.control_id === null ? {} : { controlId: row.control_id }),
		...(row.result_text === null ? {} : { resultText: row.result_text }),
	};
}

function isStatus(value: string): value is ReceiptStatus {
	return (
		value === "reserved" ||
		value === "dispatching" ||
		value === "accepted" ||
		value === "running" ||
		value === "completed" ||
		value === "blocked" ||
		value === "failed" ||
		value === "uncertain"
	);
}

function waiterKey(parentSessionId: string, delegationId: string): string {
	return `${parentSessionId}\n${delegationId}`;
}

function notify(parentSessionId: string, delegationId: string): void {
	const set = waiters.get(waiterKey(parentSessionId, delegationId));
	if (set === undefined) return;
	for (const wake of set) wake();
}
