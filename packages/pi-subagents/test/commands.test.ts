import { describe, expect, test } from "vitest";
import { formatStatusLine } from "../src/commands.js";
import type { PublicSubagent } from "../src/domain.js";

function child(overrides: Partial<PublicSubagent> = {}): PublicSubagent {
	return {
		id: "sa_aaaaaaaaaaaa",
		agent: "worker",
		state: "running",
		mode: "rpc",
		cwd: "/tmp/work",
		sessionId: "session-1",
		freshness: "live",
		interactive: false,
		model: { provider: "test", id: "model", source: "parent" },
		thinking: { level: "off", source: "parent" },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("parent status line", () => {
	test("hides when every child is terminal and names interrupted TUI children", () => {
		expect(
			formatStatusLine([child({ state: "done" }), child({ state: "stopped" })]),
		).toBeUndefined();
		expect(
			formatStatusLine([
				child({ displayName: "Reviewer", state: "idle", mode: "tui", interrupted: "paused" }),
				child({ agent: "scout", state: "failed" }),
			]),
		).toBe("Reviewer tui interrupted · scout failed");
	});
});
