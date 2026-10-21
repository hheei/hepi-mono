import { writeFileSync } from "node:fs";
import type { SystemMessage } from "@earendil-works/pi-ai";
import type { Entry } from "./types.js";

interface SessionManagerLike {
	fileEntries: Entry[];
	byId: Map<string, Entry>;
	persist?: boolean | undefined;
	sessionFile?: string | undefined;
	getBranch: (fromId?: string) => Entry[];
	getEntry: (id: string) => Entry | undefined;
	_appendEntry: (entry: Entry) => void;
	_persist: (entry: Entry) => void;
	_rewriteFile: () => void;
	_buildIndex: () => void;
}

/**
 * Runtime boundary type guard for SystemMessage.
 */
export function isSystemMessage(val: unknown): val is SystemMessage {
	return (
		typeof val === "object" &&
		val !== null &&
		(val as { role?: unknown }).role === "system" &&
		("content" in val || "sections" in val)
	);
}

/**
 * Compare two system messages for semantic equivalence (content, sections, and tool declarations).
 */
export function isEquivalentSystemMessage(a: unknown, b: unknown): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	if (!isSystemMessage(a) || !isSystemMessage(b)) return false;

	if (JSON.stringify(a.content) !== JSON.stringify(b.content)) return false;
	if (JSON.stringify(a.sections ?? {}) !== JSON.stringify(b.sections ?? {})) return false;
	if (JSON.stringify(a.toolsAdded ?? []) !== JSON.stringify(b.toolsAdded ?? [])) return false;
	if (JSON.stringify(a.toolsRemoved ?? []) !== JSON.stringify(b.toolsRemoved ?? [])) return false;

	return true;
}

/**
 * Resolve a valid SystemMessage from an entry (either from entry.systemMessage or message-entry.message).
 */
export function resolveEntrySystemMessage(entry?: Entry | null): SystemMessage | undefined {
	if (!entry) return undefined;
	if (isSystemMessage(entry.systemMessage)) {
		return entry.systemMessage;
	}
	if (entry.type === "message" && isSystemMessage(entry.message)) {
		return entry.message;
	}
	return undefined;
}

/**
 * Hydrate compaction entries in a SessionManager that reference an ancestor checkpoint.
 * Points entry.systemMessage to the ancestor's systemMessage in-memory object reference.
 */
export function hydrateCompactionCheckpoints(manager?: unknown): void {
	if (!manager || typeof manager !== "object") return;
	const m = manager as { fileEntries?: Entry[] | undefined; byId?: Map<string, Entry> | undefined };
	if (!Array.isArray(m.fileEntries) || !m.byId) return;
	for (const entry of m.fileEntries) {
		if (
			entry.type === "compaction" &&
			entry.systemMessage === undefined &&
			entry.checkpointEntryId
		) {
			const target = m.byId.get(entry.checkpointEntryId);
			const resolved = resolveEntrySystemMessage(target);
			if (resolved) {
				entry.systemMessage = resolved;
			}
		}
	}
}

// Track reference counts and original methods per prototype for safe concurrent lifecycle management
type PatchedProtoState = {
	refCount: number;
	_appendEntry: (entry: Entry) => void;
	_persist: (entry: Entry) => void;
	_rewriteFile: () => void;
	_buildIndex: () => void;
};
const patchedPrototypes = new WeakMap<object, PatchedProtoState>();

/**
 * Install compaction checkpoint deduplication on SessionManager prototype.
 *
 * 1. _appendEntry: When a compaction entry has a systemMessage identical to an earlier
 *    checkpoint on the branch (or the root system message), annotates entry.checkpointEntryId
 *    and shares the in-memory reference.
 * 2. _persist: Omits systemMessage when serializing to disk if checkpointEntryId is present,
 *    saving ~90KB of duplicate prompt text per compaction.
 * 3. _rewriteFile: Maintains deduplication on disk when ancestor exists in closure, and materializes
 *    full systemMessage when ancestor is missing (e.g. pruned during fork).
 * 4. _buildIndex: Hydrates shared in-memory references when sessions are loaded or branched.
 *
 * Uses reference counting per prototype so multiple or overlapping lifecycles (such as extension reloads)
 * maintain the patch until the last owner disposes.
 */
export function installCompactionCheckpointDedup(ManagerClass?: unknown): () => void {
	if (typeof ManagerClass !== "function" || !ManagerClass.prototype) {
		return () => {};
	}

	// Narrow interop access to SessionManager prototype methods
	const proto = ManagerClass.prototype as SessionManagerLike;
	if (typeof proto._appendEntry !== "function") {
		return () => {};
	}

	let state = patchedPrototypes.get(proto);
	if (!state) {
		const origAppendEntry = proto._appendEntry;
		const origPersist = proto._persist;
		const origRewriteFile = proto._rewriteFile;
		const origBuildIndex = proto._buildIndex;

		state = {
			refCount: 1,
			_appendEntry: origAppendEntry,
			_persist: origPersist,
			_rewriteFile: origRewriteFile,
			_buildIndex: origBuildIndex,
		};
		patchedPrototypes.set(proto, state);

		proto._appendEntry = function (this: SessionManagerLike, entry: Entry): void {
			if (entry.type === "compaction" && isSystemMessage(entry.systemMessage)) {
				const branch = this.getBranch();
				for (let i = branch.length - 1; i >= 0; i--) {
					const ancestor = branch[i];
					if (!ancestor) continue;
					const ancestorMsg = resolveEntrySystemMessage(ancestor);
					if (ancestorMsg && isEquivalentSystemMessage(entry.systemMessage, ancestorMsg)) {
						entry.checkpointEntryId = ancestor.id;
						entry.systemMessage = ancestorMsg;
						break;
					}
				}
			}
			origAppendEntry.call(this, entry);
		};

		proto._persist = function (this: SessionManagerLike, entry: Entry): void {
			if (
				entry.type === "compaction" &&
				entry.checkpointEntryId !== undefined &&
				entry.systemMessage !== undefined
			) {
				if (this.byId.has(entry.checkpointEntryId)) {
					const { systemMessage: _omitted, ...serialized } = entry;
					origPersist.call(this, serialized as Entry);
					return;
				}
			}
			origPersist.call(this, entry);
		};

		proto._rewriteFile = function (this: SessionManagerLike): void {
			if (!this.persist || !this.sessionFile) return;
			const ids = new Set(this.fileEntries.map((e) => e.id));
			const lines = this.fileEntries.map((entry) => {
				if (entry.type === "compaction" && entry.checkpointEntryId !== undefined) {
					if (ids.has(entry.checkpointEntryId)) {
						// Ancestor is present in this session closure: omit systemMessage to save disk space
						const { systemMessage: _omitted, ...serialized } = entry;
						return JSON.stringify(serialized);
					}
					// Ancestor is missing from fileEntries (pruned / detached fork):
					// Defensively ensure systemMessage is materialized before removing checkpoint reference
					if (!isSystemMessage(entry.systemMessage)) {
						const ancestor = this.byId.get(entry.checkpointEntryId);
						const materialized = resolveEntrySystemMessage(ancestor);
						if (materialized) {
							entry.systemMessage = materialized;
						}
					}
					delete entry.checkpointEntryId;
				}
				return JSON.stringify(entry);
			});
			const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
			writeFileSync(this.sessionFile, content, "utf-8");
		};

		proto._buildIndex = function (this: SessionManagerLike): void {
			origBuildIndex.call(this);
			hydrateCompactionCheckpoints(this);
		};
	} else {
		state.refCount++;
	}

	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		const currentState = patchedPrototypes.get(proto);
		if (!currentState) return;
		currentState.refCount--;
		if (currentState.refCount === 0) {
			proto._appendEntry = currentState._appendEntry;
			proto._persist = currentState._persist;
			proto._rewriteFile = currentState._rewriteFile;
			proto._buildIndex = currentState._buildIndex;
			patchedPrototypes.delete(proto);
		}
	};
}
