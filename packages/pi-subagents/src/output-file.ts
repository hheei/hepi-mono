/** Bounded JSONL transcript sink for core-owned child conversations. */

import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationSubagentHandle, SubagentEvent } from "@hheei/pi-ext-core";

export function encodeCwd(cwd: string): string {
	return cwd
		.replace(/[/\\]/g, "-")
		.replace(/^[A-Za-z]:-/, "")
		.replace(/^-+/, "");
}

export function createOutputFilePath(cwd: string, agentId: string, sessionId: string): string {
	const root = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	try {
		chmodSync(root, 0o700);
	} catch (error: unknown) {
		if (process.platform !== "win32") throw error;
	}
	const dir = join(root, encodeCwd(cwd), sessionId, "tasks");
	mkdirSync(dir, { recursive: true });
	return join(dir, `${agentId}.output`);
}

export function writeInitialEntry(
	path: string,
	agentId: string,
	prompt: string,
	cwd: string,
): void {
	writeFileSync(
		path,
		`${JSON.stringify({
			isSidechain: true,
			agentId,
			type: "user",
			message: { role: "user", content: prompt },
			timestamp: new Date().toISOString(),
			cwd,
		})}\n`,
		"utf-8",
	);
}

/** Streams bounded text/tool snapshots without exposing the raw AgentSession. */
export function streamToOutputFile(
	handle: ConversationSubagentHandle,
	path: string,
	agentId: string,
	cwd: string,
): () => void {
	let lastText = "";
	const append = (type: string, message: unknown) => {
		try {
			appendFileSync(
				path,
				`${JSON.stringify({
					isSidechain: true,
					agentId,
					type,
					message,
					timestamp: new Date().toISOString(),
					cwd,
				})}\n`,
				"utf-8",
			);
		} catch {
			// Transcript output is observational and must not stop the child.
		}
	};
	const subscription = handle.subscribe({
		kinds: new Set(["text", "tool"]),
		signal: new AbortController().signal,
		onEvent: (event: SubagentEvent) => {
			if (event.kind === "text" && event.text !== lastText) {
				lastText = event.text;
				append("assistant", { role: "assistant", content: event.text });
			}
			if (event.kind === "tool" && event.state === "end") {
				append("toolResult", { role: "toolResult", toolName: event.toolName });
			}
		},
	});
	return () => subscription.dispose();
}
