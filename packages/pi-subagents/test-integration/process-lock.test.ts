import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { expect, test } from "vitest";
import { holdProcessLock, processLockHeld, processLockPath } from "../src/process-lock.js";
import { withTempDir } from "../test/helpers/tmp-dir.js";

const PARENT = "parent-1";
const CHILD = "agent-1";

/**
 * The holder prints one line after `BEGIN EXCLUSIVE` returns, so that line is the readiness
 * signal: a kill issued earlier would end a process that never took the lock and prove nothing.
 */
function reportWhenHeld(child: ReturnType<typeof spawn>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		child.stdout?.on("data", (chunk: Buffer) => {
			if (chunk.toString("utf8").includes("held")) resolve();
		});
		child.once("exit", (code) => {
			reject(new Error(`the lock holder exited (${String(code)}) before it took the lock`));
		});
		const guard = setTimeout(() => {
			reject(new Error("the lock holder never took the lock"));
		}, 30_000);
		guard.unref?.();
	});
}

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
		let errors = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			errors += chunk.toString("utf8");
		});
		try {
			await reportWhenHeld(child);
			expect(errors).toBe("");
			expect(processLockHeld(lockPath)).toBe(true);
			// The kernel drops the lock the moment the holder dies; its exit is the release event.
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
			expect(processLockHeld(lockPath)).toBe(false);
		} finally {
			child.kill("SIGKILL");
		}
	});
});

test("an in-process hold blocks the probe and its release clears it", async () => {
	await withTempDir("pi-subagents-lock-", async (directory) => {
		const lockPath = processLockPath(join(directory, "state.sqlite"), PARENT, CHILD);
		if (lockPath === undefined) throw new Error("lock path");
		const held = holdProcessLock(lockPath);
		expect(processLockHeld(lockPath)).toBe(true);
		held.release();
		expect(processLockHeld(lockPath)).toBe(false);
		held.release();
	});
});
