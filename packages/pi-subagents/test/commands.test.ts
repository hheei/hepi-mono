import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { bindParentStatus, formatStatusLine } from "../src/commands.js";
import type { PublicSubagent } from "../src/domain.js";
import type { SubagentManager } from "../src/manager.js";

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

	test("bindParentStatus safely handles stale context during refresh and disposal", async () => {
		let listener: (() => void) | undefined;
		const manager = {
			list: vi.fn().mockResolvedValue([child({ state: "running" })]),
			onChange: vi.fn((fn: () => void) => {
				listener = fn;
				return () => {
					listener = undefined;
				};
			}),
		} as unknown as SubagentManager;

		const setStatus = vi.fn();
		const context = {
			ui: {
				setStatus,
			},
		} as unknown as ExtensionContext;

		const controller = new AbortController();
		const unbind = bindParentStatus({} as ExtensionAPI, context, manager, controller.signal);

		await Promise.resolve();
		expect(setStatus).toHaveBeenCalledWith("pi-subagents", "worker running");

		// Simulate stale context throwing error
		Object.defineProperty(context, "ui", {
			get() {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			},
		});

		// Trigger change after invalidation — must not throw or unhandled reject
		listener?.();
		await Promise.resolve();

		// Disposal on stale context — must not throw
		expect(() => unbind()).not.toThrow();
	});
});
