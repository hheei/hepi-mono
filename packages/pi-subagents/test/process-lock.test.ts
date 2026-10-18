import { spawn } from "node:child_process";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createMailboxTransport } from "../src/mailbox.js";
import { holdProcessLock, processLockHeld, processLockPath } from "../src/process-lock.js";
import { enqueueCommand, openStateDb, readCommand } from "../src/state-db.js";
import { withTempDir } from "./helpers/tmp-dir.js";

const PARENT = "parent-1";
const CHILD = "agent-1";

test("a held lock blocks a probe in this process, and release clears it", async () => {
	await withTempDir("pi-subagents-lock-", async (directory) => {
		const stateFile = join(directory, "state.sqlite");
		const lockPath = processLockPath(stateFile, PARENT, CHILD);
		if (lockPath === undefined) throw new Error("lock path");
		expect(processLockHeld(lockPath)).toBe(false);
		const held = holdProcessLock(lockPath);
		expect(processLockHeld(lockPath)).toBe(true);
		held.release();
		expect(processLockHeld(lockPath)).toBe(false);
		held.release();
	});
});

test("killing the holder releases the lock", async () => {
	await withTempDir("pi-subagents-lock-", async (directory) => {
		const lockPath = processLockPath(join(directory, "state.sqlite"), PARENT, CHILD);
		if (lockPath === undefined) throw new Error("lock path");
		const child = spawn(
			process.execPath,
			[
				"-e",
				`const {DatabaseSync}=require("node:sqlite");
const {mkdirSync, writeSync}=require("node:fs");
const {dirname}=require("node:path");
mkdirSync(dirname(process.argv[1]),{recursive:true});
const db=new DatabaseSync(process.argv[1]);
db.exec("BEGIN EXCLUSIVE");
writeSync(1, "held\\n");
setInterval(()=>{},1000);`,
				lockPath,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let output = "";
		let errors = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			errors += chunk.toString("utf8");
		});
		try {
			await vi.waitFor(() => {
				expect(errors).toBe("");
				expect(output).toContain("held");
				expect(processLockHeld(lockPath)).toBe(true);
			});
			child.kill("SIGKILL");
			await vi.waitFor(() => {
				expect(processLockHeld(lockPath)).toBe(false);
			});
		} finally {
			child.kill("SIGKILL");
		}
	});
});

test("the parent hears a held lock go free", async () => {
	await withTempDir("pi-subagents-lock-", async (directory) => {
		const stateFile = join(directory, "state.sqlite");
		const lockPath = processLockPath(stateFile, PARENT, CHILD);
		if (lockPath === undefined) throw new Error("lock path");
		const held = holdProcessLock(lockPath);
		const edges: boolean[] = [];
		const mailbox = createMailboxTransport({
			filePath: stateFile,
			parentSessionId: PARENT,
			pollMs: 20,
			handleRequest: async () => undefined,
			diagnose: () => {},
		});
		mailbox.onConnectionChange((_childId, connected) => {
			edges.push(connected);
		});
		await vi.waitFor(() => {
			expect(edges).toEqual([true]);
			expect(mailbox.isConnected(CHILD)).toBe(true);
		});
		held.release();
		await vi.waitFor(() => {
			expect(edges).toEqual([true, false]);
			expect(mailbox.isConnected(CHILD)).toBe(false);
		});
		mailbox.close();
	});
});

test("a parent restart requeues its own unfinished commands and leaves the child's", async () => {
	await withTempDir("pi-subagents-lock-", async (directory) => {
		const stateFile = join(directory, "state.sqlite");
		const db = openStateDb(stateFile);
		enqueueCommand(db, {
			id: "to-parent",
			parentSessionId: PARENT,
			subagentId: CHILD,
			direction: "to_parent",
			operation: "event",
			payload: "{}",
			createdAt: 1,
		});
		enqueueCommand(db, {
			id: "to-child",
			parentSessionId: PARENT,
			subagentId: CHILD,
			direction: "to_child",
			operation: "prompt",
			payload: "{}",
			createdAt: 2,
		});
		db.prepare("UPDATE commands SET status = 'working'").run();
		const mailbox = createMailboxTransport({
			filePath: stateFile,
			parentSessionId: PARENT,
			pollMs: 1_000,
			handleRequest: async () => undefined,
		});
		expect(readCommand(db, "to-parent")?.status).toBe("pending");
		expect(readCommand(db, "to-child")?.status).toBe("working");
		mailbox.close();
	});
});
