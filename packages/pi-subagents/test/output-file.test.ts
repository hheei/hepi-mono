import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ConversationSubagentHandle,
	SubscribeSubagentEventsOptions,
} from "@hheei/pi-ext-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeCwd, streamToOutputFile } from "../src/output-file.js";

describe("encodeCwd", () => {
	it.each([
		["/Users/alice/project", "Users-alice-project"],
		["/", ""],
		["C:\\Users\\alice\\project", "Users-alice-project"],
		["c:/Users/alice/project", "Users-alice-project"],
		["//server/share/project", "server-share-project"],
		["foo//bar", "foo--bar"],
		["", ""],
	])("encodes %s as %s", (cwd, expected) => {
		expect(encodeCwd(cwd)).toBe(expected);
	});
});

describe("streamToOutputFile", () => {
	const directories: string[] = [];

	afterEach(() => {
		for (const directory of directories.splice(0))
			rmSync(directory, { recursive: true, force: true });
	});

	function fixture(): {
		path: string;
		emit: (event: unknown) => void;
		dispose: ReturnType<typeof vi.fn>;
	} {
		const directory = mkdtempSync(join(tmpdir(), "pi-subagents-output-"));
		directories.push(directory);
		const path = join(directory, "nested", "run.output");
		mkdirSync(join(directory, "nested"), { recursive: true });
		let callback: ((event: unknown) => void | Promise<void>) | undefined;
		const dispose = vi.fn();
		const handle = {
			subscribe: (options: SubscribeSubagentEventsOptions) => {
				callback = options.onEvent;
				return { dispose };
			},
		} as unknown as ConversationSubagentHandle;
		streamToOutputFile(handle, path, "agent-1", "/work/project");
		return { path, emit: (event) => void callback?.(event), dispose };
	}

	it("writes bounded core text and tool events as JSONL", () => {
		const { path, emit } = fixture();
		emit({ kind: "text", id: "subagent-1", text: "hello" });
		emit({ kind: "text", id: "subagent-1", text: "hello world" });
		emit({ kind: "tool", id: "subagent-1", toolName: "read", state: "end" });

		const entries = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as { type: string; message: { content?: string; toolName?: string } },
			);
		expect(entries.map((entry) => entry.type)).toEqual(["assistant", "assistant", "toolResult"]);
		expect(entries[1]?.message.content).toBe("hello world");
		expect(entries[2]?.message.toolName).toBe("read");
	});

	it("does not duplicate identical text snapshots", () => {
		const { path, emit } = fixture();
		emit({ kind: "text", id: "subagent-1", text: "same" });
		emit({ kind: "text", id: "subagent-1", text: "same" });

		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("detaches its core subscription on cleanup", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-subagents-output-"));
		directories.push(directory);
		const path = join(directory, "run.output");
		const dispose = vi.fn();
		const cleanup = streamToOutputFile(
			{ subscribe: () => ({ dispose }) } as unknown as ConversationSubagentHandle,
			path,
			"agent-2",
			"/work/project",
		);
		cleanup();
		expect(dispose).toHaveBeenCalledOnce();
	});
});
