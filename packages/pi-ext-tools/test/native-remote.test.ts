import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { acquireMutationLock } from "../src/apply-patch/index.js";
import { applyExactEdits, remoteMutationDetails } from "../src/native-remote.js";

describe("native SSH mutation primitives", () => {
	test("matches every edit against the original text and installs them together", () => {
		expect(
			applyExactEdits("remote.txt", "one two three", [
				{ oldText: "one", newText: "ONE" },
				{ oldText: "three", newText: "THREE" },
			]),
		).toBe("ONE two THREE");
	});

	test("rejects missing, ambiguous, and overlapping exact edits", () => {
		expect(() =>
			applyExactEdits("remote.txt", "one two", [{ oldText: "missing", newText: "X" }]),
		).toThrow("Could not find the exact text");
		expect(() =>
			applyExactEdits("remote.txt", "one one", [{ oldText: "one", newText: "X" }]),
		).toThrow("Found 2 occurrences");
		expect(() =>
			applyExactEdits("remote.txt", "one two", [
				{ oldText: "one two", newText: "X" },
				{ oldText: "one", newText: "Y" },
			]),
		).toThrow("overlaps");
		expect(applyExactEdits("remote.txt", "one", [{ oldText: "one", newText: "one" }])).toBe("one");
	});

	test("queues a second lock until the holder releases", async () => {
		const key = `test:${crypto.randomUUID()}`;
		const release = await acquireMutationLock(key);
		const pending = acquireMutationLock(key);
		await sleep(20);
		await release();
		const queued = await pending;
		await queued();
	});

	test("aborts a waiter without taking the lock", async () => {
		const key = `test:${crypto.randomUUID()}`;
		const release = await acquireMutationLock(key);
		const controller = new AbortController();
		const pending = acquireMutationLock(key, controller.signal);
		await sleep(20);
		controller.abort(new Error("cancelled"));
		await expect(pending).rejects.toThrow("cancelled");
		await release();
	});

	test("decodes persisted remote mutation outcomes", () => {
		expect(
			remoteMutationDetails({
				__piExtToolsRemoteMutation: {
					target: "ileqm",
					path: "/tmp/example.txt",
					outcome: "unconfirmed",
					error: "connection lost",
				},
			}),
		).toEqual({
			target: "ileqm",
			path: "/tmp/example.txt",
			outcome: "unconfirmed",
			error: "connection lost",
		});
	});
});
