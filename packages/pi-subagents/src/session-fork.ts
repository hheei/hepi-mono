import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, type MemoryCompactorService } from "@hheei/pi-ext-core";
import { stripHindsightContent } from "./launch-spec.js";
import type { SubagentRegistry } from "./registry.js";
import { findSessionFile } from "./session-bootstrap.js";

/** Sanitizes a single session entry for child context inheritance by stripping thinking and hindsight. */
export function sanitizeForkEntry(entry: unknown): unknown {
	if (!isRecord(entry)) return entry;
	if (entry.type === "message" && isRecord(entry.message)) {
		const message = { ...entry.message };
		if (message.role === "assistant") {
			const { thinkingSignature: _sig, ...cleanMessage } = message;
			if (Array.isArray(cleanMessage.content)) {
				let filtered = cleanMessage.content.filter(
					(block) =>
						isRecord(block) && block.type !== "thinking" && block.type !== "redacted_thinking",
				);
				filtered = filtered.map((block) => {
					if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
						return { ...block, text: stripHindsightContent(block.text) };
					}
					return block;
				});
				if (filtered.length === 0) {
					filtered = [{ type: "text", text: "(previous response)" }];
				}
				return { ...entry, message: { ...cleanMessage, content: filtered } };
			}
			return { ...entry, message: cleanMessage };
		}
		if (message.role === "user") {
			if (typeof message.content === "string") {
				return {
					...entry,
					message: { ...message, content: stripHindsightContent(message.content) },
				};
			}
			if (Array.isArray(message.content)) {
				const filtered = message.content.map((block) => {
					if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
						return { ...block, text: stripHindsightContent(block.text) };
					}
					return block;
				});
				return { ...entry, message: { ...message, content: filtered } };
			}
		}
	}
	return entry;
}

/** Parses session entries from a JSONL file. */
export async function readSessionJsonlEntries(sessionPath: string): Promise<unknown[]> {
	const raw = await readFile(sessionPath, "utf8");
	const lines = raw.split("\n");
	const entries: unknown[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			entries.push(JSON.parse(trimmed));
		} catch {
			// ignore trailing malformed line
		}
	}
	return entries;
}

export interface ForkSubagentSessionOptions {
	readonly targetSessionId: string;
	readonly targetCwd: string;
	readonly targetSessionDir: string;
	readonly forkFrom: string;
	readonly parentSessionPath?: string | undefined;
	readonly parentEntries?: readonly unknown[] | undefined;
	readonly memoryCompactor?: MemoryCompactorService | undefined;
	readonly registry?: Pick<SubagentRegistry, "get"> | undefined;
	readonly onWarning?: ((message: string) => void) | undefined;
}

/**
 * Creates a new forked session file seeded with context from a parent or prior subagent.
 * Internal thinking blocks and memory recall artifacts are sanitized, and if
 * pi-ext-memory is available, active ledger memory is compacted into an initial summary.
 */
export async function forkSubagentSession(options: ForkSubagentSessionOptions): Promise<string> {
	const {
		targetSessionId,
		targetCwd,
		targetSessionDir,
		forkFrom,
		parentSessionPath,
		parentEntries,
		memoryCompactor,
		registry,
		onWarning,
	} = options;

	let sourceEntries: readonly unknown[] = [];
	let sourceIdentifier = forkFrom;

	const isParentFork = forkFrom === "parent" || forkFrom === "self" || forkFrom === "current";

	if (isParentFork) {
		sourceIdentifier = parentSessionPath ?? "parent";
		if (parentEntries !== undefined && parentEntries.length > 0) {
			sourceEntries = parentEntries;
		} else if (parentSessionPath !== undefined) {
			sourceEntries = await readSessionJsonlEntries(parentSessionPath);
		}
	} else if (/^agent-\d+$/u.test(forkFrom) && registry !== undefined) {
		const record = await registry.get(forkFrom).catch(() => undefined);
		if (record !== undefined) {
			const subagentSessionPath =
				record.sessionPath ??
				(await findSessionFile(record.launchConfig.sessionDir, record.sessionId));
			if (subagentSessionPath !== undefined) {
				sourceIdentifier = subagentSessionPath;
				sourceEntries = await readSessionJsonlEntries(subagentSessionPath);
			} else {
				onWarning?.(`Subagent ${forkFrom} has no session file on disk; starting fresh session`);
			}
		} else {
			onWarning?.(`Subagent ${forkFrom} not found in registry; starting fresh session`);
		}
	} else {
		// Treat forkFrom as an explicit session file path
		try {
			sourceEntries = await readSessionJsonlEntries(forkFrom);
		} catch (error) {
			onWarning?.(
				`Failed to read session file from "${forkFrom}": ${error instanceof Error ? error.message : String(error)}; starting fresh session`,
			);
		}
	}

	const nonHeaderEntries = sourceEntries.filter(
		(entry) => isRecord(entry) && entry.type !== "session",
	);

	let entriesToInclude: unknown[] = [];

	// If pi-ext-memory compaction draft is available, use compacted summary as context
	if (isParentFork && memoryCompactor !== undefined) {
		try {
			const draft = memoryCompactor.createCompactionDraft(null);
			if (draft !== undefined && typeof draft.summary === "string" && draft.summary.trim() !== "") {
				const compactionEntry = {
					type: "compaction",
					id: randomUUID(),
					parentId: null,
					timestamp: new Date().toISOString(),
					summary: draft.summary,
				};
				// Keep the last 2 turns (last user and assistant) after the compaction summary
				const recentTail = nonHeaderEntries.slice(-4).map(sanitizeForkEntry);
				entriesToInclude = [compactionEntry, ...recentTail];
			}
		} catch {
			// Fall back to direct sanitized entries
		}
	}

	if (entriesToInclude.length === 0) {
		entriesToInclude = nonHeaderEntries.map(sanitizeForkEntry);
	}

	await mkdir(targetSessionDir, { recursive: true });
	const timestamp = new Date().toISOString();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const targetPath = join(targetSessionDir, `${fileTimestamp}_${targetSessionId}.jsonl`);

	const lines: string[] = [
		JSON.stringify({
			type: "session",
			version: 1,
			id: targetSessionId,
			timestamp,
			cwd: targetCwd,
			parentSession: sourceIdentifier,
		}),
	];

	for (const entry of entriesToInclude) {
		lines.push(JSON.stringify(entry));
	}

	await writeFile(targetPath, `${lines.join("\n")}\n`, "utf8");
	return targetPath;
}
