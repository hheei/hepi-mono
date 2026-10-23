import { readFile, rm } from "node:fs/promises";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createBackgroundDelivery, DEFAULT_MAX_BYTES, SPILL_NOTE_PREFIX } from "@hheei/pi-ext-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DiscoveredAgent } from "../src/agent-resolver.js";
import piSubagentsExtension, {
	createParentChannel,
	skillCatalogFromLoaded,
} from "../src/extension.js";
import { registerParentTools } from "../src/tools.js";

interface RegisteredTool {
	readonly name: string;
	readonly description: string;
	readonly promptSnippet?: string;
	readonly promptGuidelines?: readonly string[];
}

function fakePi(): {
	readonly pi: ExtensionAPI;
	readonly tools: RegisteredTool[];
	readonly events: string[];
} {
	const tools: RegisteredTool[] = [];
	const events: string[] = [];
	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		registerCommand() {
			return undefined;
		},
		on(event: string) {
			events.push(event);
		},
	} as unknown as ExtensionAPI;
	return { pi, tools, events };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("extension branch", () => {
	test("registers four parent tools without injecting system prompt guidance", () => {
		const { pi, tools } = fakePi();
		registerParentTools(pi, { closeLocalConnections: vi.fn() } as never, []);
		expect(tools.map((tool) => tool.name)).toEqual([
			"agent_spawn",
			"agent_send",
			"agent_get",
			"agent_stop",
		]);
		for (const tool of tools) {
			expect(tool.promptSnippet).toBeUndefined();
			expect(tool.promptGuidelines).toBeUndefined();
		}
		expect(tools[0]?.description).toContain("subagent task");
		expect(tools[0]?.description).toContain("<available_agents>\nNone.\n</available_agents>");
		expect(tools[0]?.description).toContain("Results are returned automatically");
		expect(tools[0]?.description).toContain("do not poll agent_get");
		expect(tools[1]?.description).toContain("resuming its session");
		expect(tools[1]?.description).toContain("Results are returned automatically");
		expect(tools[2]?.description).toContain("Results are returned automatically");
	});

	test("spawn description lists visible enabled agents with their roles", () => {
		const { pi, tools } = fakePi();
		const agents: DiscoveredAgent[] = [
			{
				name: "worker",
				path: "/worker.md",
				body: "Implement",
				enabled: true,
				frontmatter: { description: " Implements changes. " },
			},
			{
				name: "hidden",
				path: "/hidden.md",
				body: "Private",
				enabled: true,
				frontmatter: { hidden: true },
			},
			{ name: "disabled", path: "/disabled.md", body: "Disabled", enabled: false, frontmatter: {} },
			{ name: "reviewer", path: "/reviewer.md", body: "Review", enabled: true, frontmatter: {} },
		];
		registerParentTools(pi, {} as never, agents);
		expect(tools[0]?.description).toContain(
			"<available_agents>\n- reviewer: No description provided.\n- worker: Implements changes.\n</available_agents>",
		);
		expect(tools[0]?.description).not.toContain("- hidden:");
		expect(tools[0]?.description).not.toContain("- disabled:");
	});

	test("the loaded skill list becomes the name to path catalog a definition resolves", () => {
		// Pi hands over name, description and both paths; a definition names the skill, so the file
		// path is what the child has to be launched with.
		const catalog = skillCatalogFromLoaded([
			{
				name: "code-review",
				description: "Two-axis review",
				filePath: "/home/u/.agents/skills/code-review/SKILL.md",
				baseDir: "/home/u/.agents/skills/code-review",
				sourceInfo: {
					path: "/home/u/.agents/skills",
					source: "agents",
					scope: "user",
					origin: "top-level",
				},
				disableModelInvocation: false,
			},
		]);
		expect(catalog).toEqual([
			{ name: "code-review", path: "/home/u/.agents/skills/code-review/SKILL.md" },
		]);
	});

	test("child only receives contact_parent and registers bridge lifecycle listeners", () => {
		const previous = process.env;
		process.env = {
			...previous,
			PI_SUBAGENTS_PARENT_SESSION_ID: "p",
			PI_SUBAGENTS_CHILD_ID: "c",
			PI_SUBAGENTS_RUNTIME_ID: "r",
			PI_SUBAGENTS_ENDPOINT: "/x",
			PI_SUBAGENTS_TOKEN: "t",
		};
		try {
			const { pi, tools, events } = fakePi();
			piSubagentsExtension(pi);
			expect(tools.map((tool) => tool.name)).toEqual(["contact_parent"]);
			expect(tools[0]?.description).toContain("BLOCKED");
			expect(events).toEqual(
				expect.arrayContaining([
					"input",
					"agent_start",
					"agent_end",
					"session_start",
					"session_shutdown",
				]),
			);
		} finally {
			process.env = previous;
		}
	});

	test("partial or malformed identity fails closed", () => {
		const previous = process.env;
		process.env = { PI_SUBAGENTS_CHILD_ID: "c" };
		try {
			expect(() => piSubagentsExtension(fakePi().pi)).toThrow(/partial/);
		} finally {
			process.env = previous;
		}
	});
});

// A fake parent: `sendMessage` captures output, `on` lets the test fire parent lifecycle events.
function fakeParent(): {
	readonly sent: { message: Record<string, unknown>; options: unknown }[];
	readonly entries: { type: string; data: unknown }[];
	readonly ui: Pick<ExtensionUIContext, "notify">;
	readonly pi: {
		sendMessage: (m: never, o: never) => void;
		appendEntry: (type: string, data: unknown) => void;
		on: (event: string, handler: () => void) => () => void;
	};
	readonly startRun: () => void;
} {
	const sent: { message: Record<string, unknown>; options: unknown }[] = [];
	const entries: { type: string; data: unknown }[] = [];
	const handlers = new Map<string, () => void>();
	return {
		sent,
		entries,
		ui: { notify: vi.fn<ExtensionUIContext["notify"]>() },
		pi: {
			appendEntry: (type, data) => {
				entries.push({ type, data });
			},
			sendMessage: ((message: Record<string, unknown>, options: unknown) => {
				sent.push({ message, options });
			}) as never,
			on: ((event: string, handler: () => void): (() => void) => {
				handlers.set(event, handler);
				return () => handlers.delete(event);
			}) as never,
		},
		startRun: () => handlers.get("agent_start")?.(),
	};
}

function report(childId: string, message: string) {
	return {
		parentSessionId: "p",
		childId,
		agent: "scout",
		task: "look around",
		status: "done" as const,
		reason: "finished",
		message,
	};
}

test("a flush delivers every held report in one message", async () => {
	const parent = fakeParent();
	const delivery = createBackgroundDelivery();
	const channel = createParentChannel(parent.pi as never, {
		ui: parent.ui,
		isIdle: () => true,
		delivery,
	});

	void channel.deliver(report("child-1", "report 1"));
	void channel.deliver(report("child-2", "report 2"));
	void channel.deliver(report("child-3", "report 3"));

	await Promise.resolve();

	expect(parent.sent).toHaveLength(1);
	const details = parent.sent[0]?.message.details as
		| { reports: Array<{ childId: string }> }
		| undefined;
	expect(details?.reports.map((r) => r.childId)).toEqual(["child-1", "child-2", "child-3"]);
	expect(String(parent.sent[0]?.message.content)).toContain("report 2");
	channel.dispose();
});

test("an oversized child answer is capped and the rest is left on disk", async () => {
	const parent = fakeParent();
	const delivery = createBackgroundDelivery();
	const channel = createParentChannel(parent.pi as never, {
		ui: parent.ui,
		isIdle: () => true,
		delivery,
	});
	const answer = `START\n${"z".repeat(DEFAULT_MAX_BYTES * 3)}\nEND`;

	await channel.deliver(report("child-big", answer));
	await Promise.resolve();
	await Promise.resolve();

	const content = String(parent.sent[0]?.message.content ?? "");
	expect(content).toContain("START");
	expect(content).toContain("END");
	expect(content).toContain(SPILL_NOTE_PREFIX);
	const path = /\[Full output: (\S+)\]/.exec(content)?.[1] ?? "";
	expect(await readFile(path, "utf8")).toBe(answer);
	await rm(path, { force: true });
	channel.dispose();
});

test("a completed child report reaches the next parent activity without a timer", async () => {
	const parent = fakeParent();
	const delivery = createBackgroundDelivery();
	const channel = createParentChannel(parent.pi as never, {
		ui: parent.ui,
		isIdle: () => true,
		delivery,
	});

	await channel.deliver(report("c", "found it"));
	await Promise.resolve();

	expect(parent.sent).toHaveLength(1);
	expect(parent.sent[0]?.message).toMatchObject({
		customType: "subagent-report",
		display: false,
		details: { reports: [report("c", "found it")] },
	});
	// `nextTurn` parks a message until the user speaks again, which is not what a finished child
	// owes the parent.
	expect(parent.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
	expect(parent.entries).toEqual([
		{
			type: "subagent-info",
			data: { id: "c", agent: "scout", status: "done", message: "found it" },
		},
	]);
	parent.startRun();
	await Promise.resolve();
	expect(parent.entries).toHaveLength(1);
});

test("an info entry failure is visible and does not resend the model report", async () => {
	const parent = fakeParent();
	parent.pi.appendEntry = () => {
		throw new Error("write failed");
	};
	const channel = createParentChannel(parent.pi as never, {
		ui: parent.ui,
		isIdle: () => true,
		delivery: createBackgroundDelivery(),
	});
	await channel.deliver(report("agent-21", "complete report"));
	expect(parent.ui.notify).toHaveBeenCalledWith(
		"Could not display subagent report for agent-21: write failed",
		"error",
	);
	parent.startRun();
	await Promise.resolve();
	channel.dispose();
	expect(parent.sent).toHaveLength(1);
	expect(parent.sent[0]?.message.content).toContain("complete report");
});

test("reports deliver without waiting for other background work", async () => {
	const parent = fakeParent();
	const delivery = createBackgroundDelivery();
	const channel = createParentChannel(parent.pi as never, {
		ui: parent.ui,
		isIdle: () => true,
		delivery,
	});
	await channel.deliver(report("a", "first"));
	expect(parent.sent).toHaveLength(1);
	expect(String(parent.sent[0]?.message.content)).toContain("first");
	expect(parent.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
	channel.dispose();
});

test("a report that arrives while the parent is busy is not held", async () => {
	const parent = fakeParent();
	const delivery = createBackgroundDelivery();
	const channel = createParentChannel(parent.pi as never, {
		ui: parent.ui,
		isIdle: () => false,
		delivery,
	});

	await channel.deliver(report("a", "first"));
	await Promise.resolve();

	expect(parent.sent).toHaveLength(1);
	// Steer enters the next model step rather than waiting until this run ends.
	expect(parent.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
});

test.each(["blocked", "error"])("a %s report delivers and wakes the parent", async (reason) => {
	const parent = fakeParent();
	const delivery = createBackgroundDelivery();
	const idle = true;
	const channel = createParentChannel(parent.pi as never, {
		ui: parent.ui,
		isIdle: () => idle,
		delivery,
	});
	await channel.deliver({ ...report("b", "urgent help"), reason });
	expect(parent.sent).toHaveLength(1);
	expect(parent.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
	expect(parent.sent[0]?.message.content).toContain("urgent help");
	channel.dispose();
});

test("a cancelled lifecycle cannot wake the parent from a queued check", async () => {
	const parent = fakeParent();
	const controller = new AbortController();
	const channel = createParentChannel(parent.pi as never, {
		ui: parent.ui,
		isIdle: () => true,
		delivery: createBackgroundDelivery(),
		signal: controller.signal,
	});
	const accepted = channel.deliver(report("a", "held"));
	controller.abort();
	await accepted;
	expect(parent.sent).toHaveLength(0);
	channel.dispose();
	expect(parent.sent[0]?.options).toEqual({ triggerTurn: false, deliverAs: "steer" });
});

test("teardown appends what is still held without waking the parent", async () => {
	const parent = fakeParent();
	const delivery = createBackgroundDelivery();
	const channel = createParentChannel(parent.pi as never, {
		ui: parent.ui,
		isIdle: () => true,
		delivery,
	});

	void channel.deliver(report("a", "first"));
	channel.dispose();

	expect(parent.sent).toHaveLength(1);
	expect(parent.sent[0]?.options).toEqual({ triggerTurn: false, deliverAs: "steer" });
	await Promise.resolve();
	expect(parent.sent).toHaveLength(1);
});
