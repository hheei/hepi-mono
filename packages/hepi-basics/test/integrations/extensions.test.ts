import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	orcaAssistantText,
	registerOrcaAgentStatus,
} from "../../src/integrations/orca-agent-status.js";
import { registerOrcaPrefill } from "../../src/integrations/orca-prefill.js";
import { registerOrcaTitlebarSpinner } from "../../src/integrations/orca-titlebar-spinner.js";

type Handler = (event: never, ctx: ExtensionContext) => void | Promise<void>;

const environment = { ...process.env };

afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (environment[key] === undefined) delete process.env[key];
	}
	Object.assign(process.env, environment);
});

function harness(): {
	readonly pi: ExtensionAPI;
	readonly handlers: Map<string, Handler[]>;
	readonly titles: string[];
	readonly editorText: string[];
	readonly context: ExtensionContext;
} {
	const handlers = new Map<string, Handler[]>();
	const titles: string[] = [];
	const editorText: string[] = [];
	const pi = {
		events: {},
		on: (event: string, handler: Handler) => {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		getSessionName: () => "Integration test",
	} as unknown as ExtensionAPI;
	const context = {
		hasUI: true,
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => "integration-test",
			getSessionFile: () => undefined,
		},
		ui: {
			setEditorText: (text: string) => editorText.push(text),
			setTitle: (title: string) => titles.push(title),
		},
	} as unknown as ExtensionContext;
	return { pi, handlers, titles, editorText, context };
}

async function emit(
	handlers: ReadonlyMap<string, readonly Handler[]>,
	event: string,
	context: ExtensionContext,
): Promise<void> {
	for (const handler of handlers.get(event) ?? []) await handler({} as never, context);
}

test("Orca prefill consumes its environment value once and stale reload handlers are inert", async () => {
	process.env.ORCA_PANE_KEY = "pane";
	process.env.ORCA_PI_PREFILL = "Review the changes";
	const { pi, handlers, editorText, context } = harness();
	registerOrcaPrefill(pi);
	registerOrcaPrefill(pi);
	for (const handler of handlers.get("session_start") ?? [])
		await handler({ reason: "startup" } as never, context);
	expect(editorText).toEqual(["Review the changes"]);
	expect(process.env.ORCA_PI_PREFILL).toBeUndefined();
});

test("Orca title stays static through agent lifecycle", async () => {
	process.env.ORCA_PANE_KEY = "pane";
	const { pi, handlers, titles, context } = harness();
	registerOrcaTitlebarSpinner(pi);
	await emit(handlers, "session_start", context);
	await emit(handlers, "agent_start", context);
	await emit(handlers, "agent_settled", context);
	expect(titles).toHaveLength(1);
});

test("Orca title restores the Pi session name when a section opens", async () => {
	process.env.ORCA_PANE_KEY = "pane";
	const { pi, handlers, titles, context } = harness();
	registerOrcaTitlebarSpinner(pi);
	await emit(handlers, "session_start", context);
	expect(titles.at(-1)).toContain("Integration test");
});

test("Orca status exposes only final assistant text", () => {
	expect(
		orcaAssistantText({
			content: [
				{ type: "reasoning", text: "hidden" },
				{ type: "text", text: "First" },
				{ type: "tool_use", name: "read" },
				{ type: "text", text: " second" },
			],
		}),
	).toBe("First second");
	expect(orcaAssistantText({ content: [{ type: "tool_use", name: "read" }] })).toBeUndefined();
});

test("Orca status posts the settled agent state to its loopback hook", async () => {
	const requests: unknown[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			requests.push(await request.json());
			return new Response(null, { status: 204 });
		},
	});
	try {
		process.env.ORCA_PANE_KEY = "pane";
		delete process.env.ORCA_AGENT_HOOK_ENDPOINT;
		delete process.env.ORCA_AGENT_HOOK_ENV;
		delete process.env.ORCA_AGENT_HOOK_VERSION;
		delete process.env.ORCA_AGENT_LAUNCH_TOKEN;
		delete process.env.ORCA_TAB_ID;
		delete process.env.ORCA_WORKTREE_ID;
		process.env.ORCA_AGENT_HOOK_PORT = String(server.port);
		process.env.ORCA_AGENT_HOOK_TOKEN = "token";
		const { pi, handlers, context } = harness();
		registerOrcaAgentStatus(pi);
		for (const handler of handlers.get("session_start") ?? [])
			await handler({ reason: "startup" } as never, context);
		await emit(handlers, "agent_settled", context);
		for (
			let attempt = 0;
			attempt < 10 &&
			!requests.some((request) =>
				JSON.stringify(request).includes('"hook_event_name":"agent_end"'),
			);
			attempt += 1
		)
			await Bun.sleep(10);
		expect(requests).toContainEqual({
			paneKey: "pane",
			launchToken: "",
			tabId: "",
			worktreeId: "",
			env: "",
			version: "",
			payload: { hook_event_name: "agent_end", session_id: "integration-test" },
		});
	} finally {
		server.stop(true);
	}
});
