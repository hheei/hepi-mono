import { join } from "node:path";
import { expect, test } from "vitest";
import { createMailboxTransport } from "../src/mailbox.js";
import { holdProcessLock, processLockPath } from "../src/process-lock.js";
import { enqueueCommand, openStateDb, readCommand } from "../src/state-db.js";
import { until, useFakeClock, useRealClock } from "./helpers/fake-clock.js";
import { withTempDir } from "./helpers/tmp-dir.js";

const PARENT = "parent-1";
const CHILD = "agent-1";

test("the parent hears a held lock go free", async () => {
	useFakeClock();
	try {
		await withTempDir("pi-subagents-lock-", async (directory) => {
			const stateFile = join(directory, "state.sqlite");
			const lockPath = processLockPath(stateFile, PARENT, CHILD);
			if (lockPath === undefined) throw new Error("lock path");
			const held = holdProcessLock(lockPath);
			const edges: boolean[] = [];
			let markEdge: () => void = () => {};
			const nextEdge = (): Promise<void> =>
				new Promise<void>((resolve) => {
					markEdge = resolve;
				});
			let edgeArrived = nextEdge();
			const mailbox = createMailboxTransport({
				filePath: stateFile,
				parentSessionId: PARENT,
				pollMs: 20,
				handleRequest: async () => undefined,
				diagnose: () => {},
			});
			mailbox.onConnectionChange((_childId, connected) => {
				edges.push(connected);
				markEdge();
			});
			await until(edgeArrived);
			expect(edges).toEqual([true]);
			expect(mailbox.isConnected(CHILD)).toBe(true);
			edgeArrived = nextEdge();
			held.release();
			await until(edgeArrived);
			expect(edges).toEqual([true, false]);
			expect(mailbox.isConnected(CHILD)).toBe(false);
			mailbox.close();
		});
	} finally {
		useRealClock();
	}
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
