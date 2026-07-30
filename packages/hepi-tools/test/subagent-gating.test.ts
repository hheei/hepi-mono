import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piAdvisorExtension from "../src/pi-advisor/extension.js";
import piAskExtension from "../src/pi-ask/extension.js";
import piGoalExtension from "../src/pi-goal/extension.js";
import piTodoExtension from "../src/pi-todo/extension.js";

type SessionStartHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type HepiExtension = (pi: ExtensionAPI) => void;

afterEach(() => {
	globalThis.__piSubagentSessionBridgesByRuntime = undefined;
});

function childHarness(): {
	readonly pi: ExtensionAPI;
	readonly commands: string[];
	readonly sessionStarts: SessionStartHandler[];
	readonly tools: string[];
} {
	const commands: string[] = [];
	const sessionStarts: SessionStartHandler[] = [];
	const tools: string[] = [];
	const events = {};
	const pi = {
		events,
		on(event: string, handler: SessionStartHandler) {
			if (event === "session_start") sessionStarts.push(handler);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		registerTool(tool: { readonly name: string }) {
			tools.push(tool.name);
		},
	} as unknown as ExtensionAPI;
	return { pi, commands, sessionStarts, tools };
}

async function expectChildFeatureDisabled(extension: HepiExtension): Promise<void> {
	const harness = childHarness();
	const subagents = new WeakMap<object, { isSubagentSession(): boolean }>();
	subagents.set(harness.pi.events, { isSubagentSession: () => true });
	globalThis.__piSubagentSessionBridgesByRuntime = subagents;

	extension(harness.pi);
	for (const start of harness.sessionStarts) await start({}, {} as ExtensionContext);

	expect(harness.tools).toEqual([]);
	expect(harness.commands).toEqual([]);
}

describe("interactive tool subagent gates", () => {
	test("Ask is absent from Pi Subagents child sessions", () =>
		expectChildFeatureDisabled(piAskExtension));
	test("Goal is absent from Pi Subagents child sessions", () =>
		expectChildFeatureDisabled(piGoalExtension));
	test("Todo is absent from Pi Subagents child sessions", () =>
		expectChildFeatureDisabled(piTodoExtension));
	test("Advisor is absent from Pi Subagents child sessions", () =>
		expectChildFeatureDisabled(piAdvisorExtension));
});
