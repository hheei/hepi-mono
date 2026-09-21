import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { createChildNudgeController, shouldScheduleAgentEndNudge } from "../src/child-nudge.js";

afterEach(() => {
	vi.useRealTimers();
});

test("completion nudge runs after the agent stops normally", () => {
	expect(shouldScheduleAgentEndNudge([{ role: "assistant", stopReason: "stop" }])).toBe(true);
});

test("completion nudge ignores provider errors, aborts, and length stops", () => {
	expect(shouldScheduleAgentEndNudge([{ role: "assistant", stopReason: "error" }])).toBe(false);
	expect(shouldScheduleAgentEndNudge([{ role: "assistant", stopReason: "aborted" }])).toBe(false);
	expect(shouldScheduleAgentEndNudge([{ role: "assistant", stopReason: "length" }])).toBe(false);
	expect(shouldScheduleAgentEndNudge([])).toBe(false);
});

function fakePi() {
	const listeners = new Map<string, Array<(event?: unknown) => void>>();
	const sendUserMessage = vi.fn();
	const pi = {
		on(event: string, handler: (event?: unknown) => void) {
			const current = listeners.get(event) ?? [];
			current.push(handler);
			listeners.set(event, current);
		},
		sendUserMessage,
		emit(event: string, payload?: unknown) {
			for (const handler of listeners.get(event) ?? []) handler(payload);
		},
	};
	return { pi: pi as unknown as ExtensionAPI & { emit: typeof pi.emit }, sendUserMessage };
}

test("sends a follow-up reminder when the child ends a turn without reporting", () => {
	vi.useFakeTimers();
	const { pi, sendUserMessage } = fakePi();
	const controller = createChildNudgeController({ delayMs: 1_000 });
	controller.listen(pi);
	pi.emit("agent_start");
	pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	vi.advanceTimersByTime(999);
	expect(sendUserMessage).not.toHaveBeenCalled();
	vi.advanceTimersByTime(1);
	expect(sendUserMessage).toHaveBeenCalledWith(
		expect.stringContaining("contact_parent"),
		expect.objectContaining({ deliverAs: "followUp" }),
	);
	controller.dispose();
});

test("cancels the reminder after contact_parent, user input, or a new agent start", () => {
	vi.useFakeTimers();

	const reported = fakePi();
	const reportedController = createChildNudgeController({ delayMs: 1_000 });
	reportedController.listen(reported.pi);
	reported.pi.emit("agent_start");
	reported.pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	reportedController.markReported();
	vi.advanceTimersByTime(2_000);
	expect(reported.sendUserMessage).not.toHaveBeenCalled();
	reportedController.dispose();

	const typed = fakePi();
	const typedController = createChildNudgeController({ delayMs: 1_000 });
	typedController.listen(typed.pi);
	typed.pi.emit("agent_start");
	typed.pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	typed.pi.emit("input");
	vi.advanceTimersByTime(2_000);
	expect(typed.sendUserMessage).not.toHaveBeenCalled();
	typedController.dispose();

	const restarted = fakePi();
	const restartedController = createChildNudgeController({ delayMs: 1_000 });
	restartedController.listen(restarted.pi);
	restarted.pi.emit("agent_start");
	restarted.pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	restarted.pi.emit("agent_start");
	vi.advanceTimersByTime(2_000);
	expect(restarted.sendUserMessage).not.toHaveBeenCalled();
	restartedController.dispose();
});

test("allows another reminder after a later turn when the previous report was already sent", () => {
	vi.useFakeTimers();
	const { pi, sendUserMessage } = fakePi();
	const controller = createChildNudgeController({ delayMs: 1_000 });
	controller.listen(pi);
	pi.emit("agent_start");
	pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	controller.markReported();
	vi.advanceTimersByTime(2_000);
	expect(sendUserMessage).not.toHaveBeenCalled();

	pi.emit("agent_start");
	pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	vi.advanceTimersByTime(1_000);
	expect(sendUserMessage).toHaveBeenCalledOnce();
	controller.dispose();
});
