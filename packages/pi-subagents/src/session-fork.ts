import { readFile, stat } from "node:fs/promises";
import type { SubagentRegistry } from "./registry.js";
import { findSessionFile } from "./session-bootstrap.js";

/** Reads all JSON entries from a session file on disk. */
export async function readSessionJsonlEntries(sessionPath: string): Promise<unknown[]> {
	const raw = await readFile(sessionPath, "utf8");
	const lines = raw.split("\n").filter((line) => line.trim() !== "");
	const entries: unknown[] = [];
	for (const line of lines) {
		try {
			entries.push(JSON.parse(line));
		} catch {
			// ignore trailing malformed line
		}
	}
	return entries;
}

export interface ResolveForkSessionReferenceOptions {
	readonly forkFrom: string;
	readonly parentSessionPath?: string | undefined;
	readonly registry?: Pick<SubagentRegistry, "get"> | undefined;
	readonly onWarning?: ((message: string) => void) | undefined;
}

/**
 * Resolves the source session JSONL file path for on-demand context inspection.
 * Rejects 'current' to prevent ambiguous self-references.
 */
export async function resolveForkSessionReference(
	options: ResolveForkSessionReferenceOptions,
): Promise<string> {
	const { forkFrom, parentSessionPath, registry } = options;
	const target = forkFrom.trim();

	if (target === "current") {
		throw new Error(
			"forkFrom cannot be 'current'. Use 'parent' to reference the parent session, or specify a subagent id like 'agent-1'.",
		);
	}

	if (target === "parent" || target === "self") {
		if (parentSessionPath !== undefined && parentSessionPath.trim() !== "") {
			return parentSessionPath;
		}
		throw new Error("Parent session has no associated session file on disk to reference");
	}

	if (registry !== undefined) {
		const record = await registry.get(target).catch(() => undefined);
		if (record !== undefined) {
			const subagentSessionPath =
				record.sessionPath ??
				(await findSessionFile(record.launchConfig.sessionDir, record.sessionId));
			if (subagentSessionPath !== undefined) {
				return subagentSessionPath;
			}
			throw new Error(`Subagent ${target} has no session file on disk to reference`);
		}
		if (/^agent-\d+$/u.test(target)) {
			throw new Error(`Subagent ${target} was not found in registry`);
		}
	}

	// Treat as explicit session file path
	try {
		const st = await stat(target);
		if (st.isFile()) return target;
	} catch {
		// ignore
	}

	throw new Error(`Referenced session file not found: ${target}`);
}

/** Formats instructions explaining where the referenced session file is and how to inspect it on demand. */
export function formatSessionReferencePrompt(sessionPath: string): string {
	return [
		"## Referenced Session Context",
		"Prior session transcript is available for reference at:",
		sessionPath,
		"Use tools (such as read or grep) to inspect earlier messages, tool outputs, or context from this JSONL file on demand as needed instead of loading the entire history.",
	].join("\n");
}
