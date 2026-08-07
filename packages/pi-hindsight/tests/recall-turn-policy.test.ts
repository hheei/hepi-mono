import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../extensions/config/config.js";
import { createRecallTurnPolicy } from "../extensions/lifecycle/memory-lifecycle-recall.js";
import type { RuntimeSnapshot } from "../extensions/lifecycle/memory-lifecycle-runtime.js";
import { readLastRecallSnapshot } from "../extensions/lifecycle/recall-visibility.js";
import type { ResolvedConfig } from "../extensions/types.js";

function runtimeFor(cwd: string): RuntimeSnapshot {
	mkdirSync(join(cwd, ".git"));
	return { cwd, ui: { setStatus: () => undefined, notify: () => undefined } };
}

describe("createRecallTurnPolicy unexpected failure", () => {
	it("discloses rendered automatic recall results to the user", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-recall-turn-"));
		const runtime = runtimeFor(cwd);
		const notifications: Array<{ message: string; level: string }> = [];
		const policy = createRecallTurnPolicy({
			getConfig: () => DEFAULT_CONFIG,
			getClient: () =>
				({
					recall: async () => [{ text: "Retry network timeouts three times." }],
				}) as never,
			setMemoryStatus: () => undefined,
			notify: (_runtime, message, level) => notifications.push({ message, level }),
		});

		const result = await policy.recall(
			{
				messages: [{ role: "user", content: "How should timeout retry work?", timestamp: 1 }],
			} as never,
			runtime,
		);

		expect(result).toBeDefined();
		expect(notifications).toContainEqual({
			message: expect.stringContaining("Retry network timeouts three times."),
			level: "info",
		});
	});

	it("writes a debug snapshot when storeLastRecall + storeLastRecallFailures are enabled", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-recall-turn-"));
		const runtime = runtimeFor(cwd);
		const statuses: string[] = [];
		const config: ResolvedConfig = {
			...DEFAULT_CONFIG,
			recall: { ...DEFAULT_CONFIG.recall, storeLastRecall: true, storeLastRecallFailures: true },
		};

		const policy = createRecallTurnPolicy({
			getConfig: () => config,
			getClient: () => {
				throw new Error("client unavailable");
			},
			setMemoryStatus: (_runtime, activity) => {
				statuses.push(activity);
			},
			notify: () => undefined,
		});

		const result = await policy.recall(
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] } as never,
			runtime,
		);

		expect(result).toBeUndefined();
		expect(statuses).toEqual(["recalling", "recall-failed"]);
		const snapshot = await readLastRecallSnapshot(cwd, config.recall.lastRecallPath);
		expect(snapshot?.failed).toBe(1);
		expect(snapshot?.failures?.[0]?.error).toContain("client unavailable");
	});

	it("does not write a snapshot when storeLastRecallFailures is disabled (default)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-recall-turn-"));
		const runtime = runtimeFor(cwd);
		const config: ResolvedConfig = DEFAULT_CONFIG;

		const policy = createRecallTurnPolicy({
			getConfig: () => config,
			getClient: () => {
				throw new Error("client unavailable");
			},
			setMemoryStatus: () => undefined,
			notify: () => undefined,
		});

		await policy.recall(
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] } as never,
			runtime,
		);

		const snapshot = await readLastRecallSnapshot(cwd, config.recall.lastRecallPath);
		expect(snapshot).toBeUndefined();
	});
});
