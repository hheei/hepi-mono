import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { acquireMutationLock, withMutationLock } from "../src/index.js";

test("releases a mutation lock when its callback fails", async () => {
	const key = randomUUID();
	await expect(
		withMutationLock(key, undefined, async () => {
			throw new Error("callback failed");
		}),
	).rejects.toThrow("callback failed");
	const unlock = await acquireMutationLock(key);
	await unlock();
});

test("already cancelled callers never run or acquire a lock", async () => {
	const key = randomUUID();
	let ran = false;
	await expect(
		withMutationLock(key, AbortSignal.abort(new Error("cancelled")), async () => {
			ran = true;
		}),
	).rejects.toThrow("cancelled");
	expect(ran).toBe(false);
	const unlock = await acquireMutationLock(key);
	await unlock();
});
