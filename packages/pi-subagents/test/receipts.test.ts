import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
	abandonReceipts,
	readReceiptRevision,
	readStoredReceipt,
	reserveReceipt,
	settleReceipts,
	sweepUncertainDispatch,
	updateReceipt,
	waitForReceipt,
} from "../src/receipts.js";

const parent = "01a17c90-2f44-76a4-acf8-cfdde8339243";

test("delegation revisions increase separately for each agent and parent", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-revisions-"));
	const file = join(dir, "state.sqlite");
	try {
		const reserve = (parentSessionId: string, childId: string) =>
			reserveReceipt(file, { parentSessionId, childId, task: "work", delivery: "detached" });
		const first = reserve(parent, "agent-1");
		const second = reserve(parent, "agent-1");
		expect([first.revision, second.revision]).toEqual([1, 2]);
		expect(reserve(parent, "agent-2").revision).toBe(1);
		expect(reserve("another-parent", "agent-1").revision).toBe(1);
		expect(readStoredReceipt(file, parent, first.delegationId)?.revision).toBe(1);
		expect(readReceiptRevision(file, parent, "agent-1", 2)?.delegationId).toBe(second.delegationId);
		expect(readReceiptRevision(file, parent, "agent-2", 2)).toBeUndefined();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("receipts settle one waiting delegation and keep the next copy of the same task", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-receipts-"));
	const file = join(dir, "state.sqlite");
	try {
		const first = reserveReceipt(file, {
			parentSessionId: parent,
			task: "same task",
			childId: "child-1",
			delivery: "pending",
		});
		expect(() =>
			reserveReceipt(file, {
				parentSessionId: parent,
				task: "same task",
				childId: "child-1",
				delivery: "pending",
			}),
		).toThrow(/already has a waiting delegation/);
		updateReceipt(file, parent, first.delegationId, {
			from: ["reserved"],
			status: "accepted",
			runBoundary: 2,
		});
		const other = reserveReceipt(file, {
			parentSessionId: parent,
			task: "later task",
			childId: "child-1",
			delivery: "detached",
		});
		updateReceipt(file, parent, other.delegationId, {
			from: ["reserved"],
			status: "accepted",
			runBoundary: 3,
		});
		const settled = settleReceipts(file, parent, {
			childId: "child-1",
			status: "completed",
			message: "done",
			workVersion: 2,
		});
		expect(settled.map((receipt) => receipt.delegationId)).toEqual([first.delegationId]);
		expect(readStoredReceipt(file, parent, other.delegationId)?.status).toBe("accepted");
		const second = reserveReceipt(file, {
			parentSessionId: parent,
			task: "same task",
			childId: "child-1",
			delivery: "pending",
		});
		expect(readStoredReceipt(file, parent, second.delegationId)?.status).toBe("reserved");

		const compact = reserveReceipt(file, {
			parentSessionId: parent,
			task: "/compact",
			childId: "child-2",
			delivery: "pending",
		});
		updateReceipt(file, parent, compact.delegationId, {
			from: ["reserved"],
			status: "accepted",
			controlId: "compact-1",
		});
		expect(
			settleReceipts(file, parent, {
				childId: "child-2",
				status: "completed",
				message: "ordinary answer",
				workVersion: 1,
			}),
		).toEqual([]);
		expect(
			settleReceipts(file, parent, {
				childId: "child-2",
				status: "completed",
				message: "Context compacted (10 -> 4 tokens).",
				controlId: "compact-1",
			})[0]?.status,
		).toBe("completed");
		// A compaction report cannot settle a turn that started after it.
		const afterCompaction = reserveReceipt(file, {
			parentSessionId: parent,
			task: "next turn",
			childId: "child-2",
			delivery: "pending",
		});
		updateReceipt(file, parent, afterCompaction.delegationId, {
			from: ["reserved"],
			status: "accepted",
			runBoundary: 7,
		});
		expect(
			settleReceipts(file, parent, {
				childId: "child-2",
				status: "completed",
				message: "late compaction",
				controlId: "compact-2",
			}),
		).toEqual([]);
		expect(readStoredReceipt(file, parent, afterCompaction.delegationId)?.status).toBe("accepted");
		abandonReceipts(file, parent, "child-2", "cleanup");

		const crashed = reserveReceipt(file, {
			parentSessionId: parent,
			task: "maybe sent",
			delivery: "pending",
		});
		updateReceipt(file, parent, crashed.delegationId, {
			from: ["reserved"],
			status: "dispatching",
		});
		expect(sweepUncertainDispatch(file, parent)).toBe(1);
		expect(readStoredReceipt(file, parent, crashed.delegationId)?.status).toBe("uncertain");

		const waiting = reserveReceipt(file, {
			parentSessionId: parent,
			task: "later",
			childId: "child-3",
			delivery: "pending",
		});
		updateReceipt(file, parent, waiting.delegationId, {
			from: ["reserved"],
			status: "accepted",
			runBoundary: 4,
		});
		const finished = waitForReceipt(file, parent, waiting.delegationId);
		settleReceipts(file, parent, {
			childId: "child-3",
			status: "blocked",
			message: "need input",
			workVersion: 4,
		});
		await expect(finished).resolves.toMatchObject({ status: "blocked", resultText: "need input" });

		const hanging = reserveReceipt(file, {
			parentSessionId: parent,
			task: "still going",
			childId: "child-4",
			delivery: "pending",
		});
		updateReceipt(file, parent, hanging.delegationId, {
			from: ["reserved"],
			status: "accepted",
			runBoundary: 1,
		});
		const stopped = waitForReceipt(file, parent, hanging.delegationId);
		abandonReceipts(file, parent, "child-4", "Child was stopped before the delegation finished");
		await expect(stopped).resolves.toMatchObject({ status: "failed" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
