/**
 * Adapt a Pi `getBranch()` path into the host's compaction-aware projection.
 *
 * `getBranch()` is the raw leaf-to-root path, including pre-compaction history
 * and `context_edit` entries. `buildSessionProjection()` is the same function
 * Pi uses before cloning `event.messages`, so aligned ids and kept-tail token
 * estimates follow native omission/replacement instead of re-implementing the
 * window walk.
 */
import {
	buildSessionProjection,
	type SessionEntry,
	type SessionProjection,
} from "@earendil-works/pi-coding-agent";

export function projectPiBranchEntries(entries: readonly unknown[]): SessionProjection {
	const path = sessionPathForProjection(entries);
	const leafId = path.at(-1)?.id ?? null;
	return buildSessionProjection(path, leafId);
}

export function alignedIdsFromPiBranchEntries(entries: readonly unknown[]): (string | undefined)[] {
	return alignedIdsFromSessionProjection(projectPiBranchEntries(entries));
}

export function alignedIdsFromSessionProjection(
	projection: SessionProjection,
): (string | undefined)[] {
	const ids: (string | undefined)[] = [];
	for (const projected of projection.entries) {
		const count = projected.messages.length;
		if (count === 0) continue;
		const sourceId =
			projected.sourceEntry.type === "compaction" ? undefined : projected.sourceEntry.id;
		for (let index = 0; index < count; index += 1) {
			ids.push(sourceId);
		}
	}
	return ids;
}

function sessionPathForProjection(entries: readonly unknown[]): SessionEntry[] {
	const rows: Record<string, unknown>[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (typeof (entry as { type?: unknown }).type !== "string") continue;
		rows.push(entry as Record<string, unknown>);
	}

	const linked: SessionEntry[] = [];
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index];
		if (row === undefined) continue;
		const rawId = row.id;
		const id = typeof rawId === "string" && rawId.length > 0 ? rawId : `__pi-path-${index}`;
		const rawParent = row.parentId;
		const parentId =
			typeof rawParent === "string" || rawParent === null
				? rawParent
				: index === 0
					? null
					: (linked[index - 1]?.id ?? null);
		const timestamp = typeof row.timestamp === "string" ? row.timestamp : "";
		linked.push(
			coerceProjectedEntry({
				...row,
				id,
				parentId,
				timestamp,
			}),
		);
	}
	return linked;
}

function coerceProjectedEntry(row: Record<string, unknown>): SessionEntry {
	if (row.type === "message" && (row.message === undefined || row.message === null)) {
		return {
			...row,
			message: { role: "user", content: "" },
		} as unknown as SessionEntry;
	}
	return row as unknown as SessionEntry;
}
