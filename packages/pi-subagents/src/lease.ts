import { existsSync } from "node:fs";
import type { SubagentRecord } from "./domain.js";
import { processLockHeld, processLockPath } from "./process-lock.js";
import { type SubagentRegistry, SubagentRegistryError } from "./registry.js";
import { openStateDb, readMeta, writeMeta } from "./state-db.js";

/**
 * Durable ownership of one parent session's children. Callers learn four operations. The parent
 * and child lifecycle matrices stay behind them.
 *
 * `commit` writes intent or attachment and nothing else. `roster` is this session's ledger.
 * `ready` is the barrier before a model turn: it rebinds surfaces that are still there and
 * reopens only the panels a new host generation took down. Cancel is not an operation.
 */
export const LEASE_EDGES = [
	"spawn-intent",
	"attachment-bound",
	"stop-intent",
	"runtime-gone",
	"left-session",
] as const;

export type LeaseEdge =
	| { readonly type: "spawn-intent" }
	| {
			readonly type: "attachment-bound";
			readonly attachment: NonNullable<NonNullable<SubagentRecord["runtime"]>["attachment"]>;
	  }
	| { readonly type: "stop-intent" }
	| { readonly type: "runtime-gone" }
	| { readonly type: "left-session" };

export type HostList =
	| { readonly known: false }
	| { readonly known: true; readonly generation: string; readonly present: ReadonlySet<string> };

export interface HostDirectory {
	readonly host: "herdr" | "cmux";
	list(): Promise<HostList>;
	/** Opens the same child session in a new panel. Does not write the lease. */
	open(record: SubagentRecord): Promise<{ readonly id: string } | { readonly failure: string }>;
	/** True when a human Pi already has this child session open. Those children are not rehydrated. */
	occupied?(record: SubagentRecord): boolean;
}

export interface ProcessDirectory {
	alive(pid: number): boolean;
}

export type LeaseReady =
	| {
			readonly ok: true;
			readonly rebound: readonly string[];
			readonly rehydrated: readonly string[];
			readonly stopped: readonly string[];
			/** Children whose runtime was dropped because the writer is gone. */
			readonly released: readonly string[];
	  }
	| { readonly ok: false; readonly reason: "unknown" };

export interface ConversationLease {
	commit(id: string, edge: LeaseEdge, expectedRevision?: number): Promise<SubagentRecord>;
	roster(): Promise<readonly SubagentRecord[]>;
	ready(): Promise<LeaseReady>;
}

type RegistryStore = Pick<SubagentRegistry, "get" | "list" | "update" | "path">;

export function createConversationLease(options: {
	readonly registry: RegistryStore;
	readonly hosts: HostDirectory;
	readonly processes: ProcessDirectory;
}): ConversationLease {
	const { registry, hosts, processes } = options;
	return {
		commit(id, edge, expectedRevision) {
			return commitLease(registry, id, edge, expectedRevision);
		},
		roster() {
			return registry.list();
		},
		ready() {
			return reconcile(registry, hosts, processes);
		},
	};
}

export async function commitLease(
	registry: Pick<SubagentRegistry, "get" | "update">,
	id: string,
	edge: LeaseEdge,
	expectedRevision?: number,
): Promise<SubagentRecord> {
	const current = await registry.get(id);
	if (current === undefined) {
		throw new SubagentRegistryError("unknown_child", `Unknown child ${id}`);
	}
	const next = applyLeaseEdge(current, edge);
	if (next === undefined) return current;
	return registry.update(id, expectedRevision ?? current.revision, () => next);
}

/** `undefined` means the edge changes nothing, so the caller must not write. */
export function applyLeaseEdge(
	record: SubagentRecord,
	edge: LeaseEdge,
): SubagentRecord | undefined {
	switch (edge.type) {
		case "spawn-intent":
			return record.intent === "active" ? undefined : { ...record, intent: "active" };
		case "attachment-bound": {
			if (record.runtime?.attachment !== undefined) return undefined;
			if (record.runtime === undefined) {
				throw new Error(`Child ${record.subagentId} has no runtime to attach`);
			}
			return {
				...record,
				runtime: { ...record.runtime, attachment: edge.attachment },
			};
		}
		case "stop-intent":
			return record.intent === "stopped" ? undefined : { ...record, intent: "stopped" };
		case "runtime-gone":
			if (record.runtime === undefined) return undefined;
			return omitRuntime(record);
		case "left-session":
			if (record.runtime === undefined && record.state === "done") return undefined;
			return {
				...omitRuntime(record),
				state: "done",
				interrupted:
					"The child left its session; the surface is no longer controlled by the parent",
			};
		default: {
			const unreachable: never = edge;
			return unreachable;
		}
	}
}

async function reconcile(
	registry: RegistryStore,
	hosts: HostDirectory,
	processes: ProcessDirectory,
): Promise<LeaseReady> {
	const list = await hosts.list();
	if (!list.known) return { ok: false, reason: "unknown" };
	const all = await registry.list();
	const released = new Set<string>();
	for (const record of all) {
		if (record.runtime === undefined) continue;
		const lockPath = processLockPath(registry.path, record.parentSessionId, record.subagentId);
		if (lockPath === undefined || !existsSync(lockPath)) continue;
		let held = true;
		try {
			held = processLockHeld(lockPath);
		} catch {
			continue;
		}
		if (held) continue;
		await commitLease(registry, record.subagentId, { type: "runtime-gone" });
		released.add(record.subagentId);
	}
	const records = all.filter((record) => !released.has(record.subagentId));
	const parentSessionId = all[0]?.parentSessionId;
	const stored =
		parentSessionId === undefined
			? undefined
			: await readHostGeneration(registry.path, parentSessionId);
	const rebound: string[] = [];
	const rehydrated: string[] = [];
	const stopped: string[] = [];
	let held = false;
	const panels = records.flatMap((record) => {
		const id = panelId(record);
		return id === undefined ? [] : [{ record, id }];
	});
	const present = panels.filter((item) => list.present.has(item.id));
	const missing = panels.filter((item) => !list.present.has(item.id));
	for (const item of present) rebound.push(item.record.subagentId);
	const generationChanged = stored !== undefined && stored !== list.generation;
	const reopen =
		generationChanged || (stored === undefined && present.length === 0 && missing.length > 0);
	if (reopen) {
		for (const item of missing) {
			if (item.record.intent !== "active") continue;
			if (hosts.occupied?.(item.record) === true) {
				held = true;
				continue;
			}
			const opened = await hosts.open(item.record);
			if ("failure" in opened) continue;
			await commitLease(registry, item.record.subagentId, {
				type: "attachment-bound",
				attachment: { kind: "panel", host: hosts.host, id: opened.id },
			});
			rehydrated.push(item.record.subagentId);
		}
	} else {
		for (const item of missing) {
			if (item.record.intent === "active") {
				await commitLease(registry, item.record.subagentId, { type: "stop-intent" });
				stopped.push(item.record.subagentId);
			}
			await commitLease(registry, item.record.subagentId, { type: "runtime-gone" });
		}
	}
	for (const record of records) {
		const attachment = record.runtime?.attachment;
		if (attachment?.kind !== "process") continue;
		if (processes.alive(attachment.pid)) {
			rebound.push(record.subagentId);
			continue;
		}
		await commitLease(registry, record.subagentId, { type: "runtime-gone" });
		released.add(record.subagentId);
	}
	if (!held && parentSessionId !== undefined && stored !== list.generation)
		await writeHostGeneration(registry.path, parentSessionId, list.generation);
	return { ok: true, rebound, rehydrated, stopped, released: [...released] };
}

function panelId(record: SubagentRecord): string | undefined {
	const attachment = record.runtime?.attachment;
	return attachment?.kind === "panel" ? attachment.id : undefined;
}

function omitRuntime(record: SubagentRecord): SubagentRecord {
	const { runtime: _runtime, ...rest } = record;
	return rest;
}

export function readHostGeneration(
	filePath: string,
	parentSessionId: string,
): Promise<string | undefined> {
	const value = readMeta(openStateDb(filePath), parentSessionId, "hostGeneration");
	return Promise.resolve(value === "" ? undefined : value);
}

export function writeHostGeneration(
	filePath: string,
	parentSessionId: string,
	generation: string,
): Promise<void> {
	const db = openStateDb(filePath);
	const current = readMeta(db, parentSessionId, "hostGeneration");
	if (current === generation) return Promise.resolve();
	writeMeta(db, parentSessionId, "hostGeneration", generation);
	return Promise.resolve();
}
