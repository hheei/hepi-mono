import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerHandoffCommand } from "../../src/handoff/index.js";

interface RegisteredCommand {
	readonly name: string;
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

const bridges = new WeakMap<
	object,
	{
		handoff(ctx: ExtensionCommandContext): Promise<
			| {
					context: string;
					setup?: (session: { getSessionId(): string }) => Promise<void>;
			  }
			| undefined
		>;
	}
>();

afterEach(() => {
	globalThis.__hepiMagicContextHandoffByRuntime = undefined;
});

function harness(): {
	readonly commands: RegisteredCommand[];
	readonly pi: ExtensionAPI;
} {
	const commands: RegisteredCommand[] = [];
	const pi = {
		events: {},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.push({ name, handler: command.handler });
		},
	} as unknown as ExtensionAPI;
	return { commands, pi };
}

function context(): {
	readonly ctx: ExtensionCommandContext;
	readonly compactCalls: number[];
	readonly injected: Array<{ type: string; content: string; display: boolean }>;
	readonly notices: string[];
} {
	const compactCalls: number[] = [];
	const injected: Array<{ type: string; content: string; display: boolean }> = [];
	const notices: string[] = [];
	const ctx = {
		waitForIdle: async () => undefined,
		compact(options: { onComplete?: (result: { summary: string }) => void }) {
			compactCalls.push(1);
			options.onComplete?.({ summary: "native summary" });
		},
		newSession: async (options: {
			setup?: (session: {
				getSessionId(): string;
				appendCustomMessageEntry(type: string, content: string, display: boolean): void;
			}) => Promise<void>;
			withSession?: (replacement: { ui: { notify(message: string): void } }) => Promise<void>;
		}) => {
			await options.setup?.({
				getSessionId: () => "destination",
				appendCustomMessageEntry(type, content, display) {
					injected.push({ type, content, display });
				},
			});
			await options.withSession?.({ ui: { notify: (message) => notices.push(message) } });
			return { cancelled: false };
		},
		sessionManager: { getSessionFile: () => "/tmp/parent.jsonl" },
		ui: { notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionCommandContext;
	return { ctx, compactCalls, injected, notices };
}

test("handoff uses Pi compaction when Magic Context is unavailable", async () => {
	const host = harness();
	const state = context();
	registerHandoffCommand(host.pi);

	await host.commands[0]?.handler("", state.ctx);

	expect(state.compactCalls).toHaveLength(1);
	expect(state.injected).toEqual([
		{
			type: "hepi-handoff",
			content: "<handoff-summary>\nnative summary\n</handoff-summary>",
			display: false,
		},
	]);
});

test("handoff prefers Magic Context's runtime bridge", async () => {
	const host = harness();
	const state = context();
	globalThis.__hepiMagicContextHandoffByRuntime = bridges;
	bridges.set(host.pi.events, {
		handoff: async () => ({ context: "<session-history>magic</session-history>" }),
	});
	registerHandoffCommand(host.pi);

	await host.commands[0]?.handler("", state.ctx);

	expect(state.compactCalls).toHaveLength(0);
	expect(state.injected[0]?.content).toBe("<session-history>magic</session-history>");
});

test("handoff runs Magic Context migration before injecting the tail", async () => {
	const host = harness();
	const state = context();
	let migratedSession = "";
	globalThis.__hepiMagicContextHandoffByRuntime = bridges;
	bridges.set(host.pi.events, {
		handoff: async () => ({
			context: "<handoff-tail>reduced</handoff-tail>",
			setup: async (session) => {
				migratedSession = session.getSessionId();
			},
		}),
	});
	registerHandoffCommand(host.pi);

	await host.commands[0]?.handler("", state.ctx);

	expect(migratedSession).toBe("destination");
	expect(state.injected[0]?.content).toBe("<handoff-tail>reduced</handoff-tail>");
});
