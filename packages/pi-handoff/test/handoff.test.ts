import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerHandoffCommand } from "../src/handoff.js";

interface RegisteredCommand {
	readonly name: string;
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface HandoffHarness {
	readonly pi: ExtensionAPI;
	readonly commands: readonly RegisteredCommand[];
	readonly command: RegisteredCommand;
	readonly calls: string[];
	readonly notices: string[];
	readonly injected: string[];
	readonly parentSessions: Array<string | undefined>;
	readonly state: { compact: "success" | "failure"; cancelled: boolean; setupFails: boolean };
	readonly context: ExtensionCommandContext;
}

function harness(): HandoffHarness {
	const commands: RegisteredCommand[] = [];
	const calls: string[] = [];
	const notices: string[] = [];
	const injected: string[] = [];
	const parentSessions: Array<string | undefined> = [];
	const state: HandoffHarness["state"] = {
		compact: "success",
		cancelled: false,
		setupFails: false,
	};
	const pi = {
		registerCommand(name: string, command: Omit<RegisteredCommand, "name">): void {
			commands.push({ name, handler: command.handler });
		},
	} as unknown as ExtensionAPI;
	registerHandoffCommand(pi);
	const context = {
		waitForIdle: async (): Promise<void> => {
			calls.push("idle");
		},
		compact(options: {
			onComplete?: (result: { summary: string }) => void;
			onError?: (error: Error) => void;
		}): void {
			calls.push("compact");
			if (state.compact === "failure") options.onError?.(new Error("provider failed"));
			else options.onComplete?.({ summary: "native summary" });
		},
		newSession: async (options: {
			readonly parentSession?: string;
			readonly setup?: (session: {
				appendCustomMessageEntry(type: string, content: string, display: boolean): void;
			}) => Promise<void>;
			readonly withSession?: (replacement: {
				readonly ui: { notify(message: string, level?: string): void };
			}) => Promise<void>;
		}): Promise<{ cancelled: boolean }> => {
			calls.push("new-session");
			parentSessions.push(options.parentSession);
			await options.setup?.({
				appendCustomMessageEntry(_type, content): void {
					if (state.setupFails) throw new Error("setup failed");
					injected.push(content);
				},
			});
			if (!state.cancelled)
				await options.withSession?.({ ui: { notify: (message) => notices.push(message) } });
			return { cancelled: state.cancelled };
		},
		sessionManager: { getSessionFile: () => "/tmp/parent.jsonl" },
		ui: { notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionCommandContext;
	const command = commands[0];
	if (command === undefined) throw new Error("handoff command was not registered");
	return { pi, commands, command, calls, notices, injected, parentSessions, state, context };
}

test("does not duplicate the command after extension reload", () => {
	const state = harness();
	registerHandoffCommand(state.pi);
	expect(state.commands).toHaveLength(1);
});

test("waits idle, compacts, and seeds a linked replacement session", async () => {
	const state = harness();
	await state.command.handler("", state.context);
	expect(state.calls).toEqual(["idle", "compact", "new-session"]);
	expect(state.parentSessions).toEqual(["/tmp/parent.jsonl"]);
	expect(state.injected).toEqual(["<handoff-summary>\nnative summary\n</handoff-summary>"]);
	expect(state.notices).toEqual(["Handoff context is ready."]);
});

test("rejects arguments without changing the session", async () => {
	const state = harness();
	await state.command.handler("extra", state.context);
	expect(state.calls).toEqual([]);
	expect(state.notices).toEqual(["Usage: /handoff"]);
});

test("reports cancellation and failure without retrying", async () => {
	const cancelled = harness();
	cancelled.state.cancelled = true;
	await cancelled.command.handler("", cancelled.context);
	expect(cancelled.notices).toEqual(["Handoff cancelled."]);

	const failed = harness();
	failed.state.compact = "failure";
	await failed.command.handler("", failed.context);
	expect(failed.calls).toEqual(["idle", "compact"]);
	expect(failed.notices).toEqual(["Handoff failed. The source session can be resumed."]);

	const setupFailure = harness();
	setupFailure.state.setupFails = true;
	await setupFailure.command.handler("", setupFailure.context);
	expect(setupFailure.calls).toEqual(["idle", "compact", "new-session"]);
	expect(setupFailure.notices).toEqual(["Handoff failed. The source session can be resumed."]);
});
