import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBackgroundDelivery } from "@hheei/pi-ext-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
	test("registers exactly five parent tools that forbid polling for results", () => {
		const { pi, tools } = fakePi();
		registerParentTools(pi, { closeLocalConnections: vi.fn() } as never);
		expect(tools.map((tool) => tool.name)).toEqual([
			"spawn_agent",
			"send_agent",
			"get_agent",
			"list_agents",
			"stop_agent",
		]);
		expect(tools[0]?.description).toContain("Do NOT poll");
		expect(tools[0]?.promptSnippet).toContain("do not poll");
		expect(tools[0]?.promptGuidelines?.join("\n")).toContain("tail session/log files");
		// Spawning clarifies that idle subagents need not be frozen or stopped.
		expect(tools[0]?.promptGuidelines?.join("\n")).toContain("idle subagents consume no compute");
		expect(tools[1]?.description).toContain("Do NOT poll");
		expect(tools[2]?.description).toContain("not to wait");
		expect(tools[3]?.description).toContain("not to wait");
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
	readonly pi: {
		sendMessage: (m: never, o: never) => void;
		on: (event: string, handler: () => void) => () => void;
	};
	readonly startRun: () => void;
} {
	const sent: { message: Record<string, unknown>; options: unknown }[] = [];
	const handlers = new Map<string, () => void>();
	return {
		sent,
		pi: {
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

test("a completed child report reaches the next parent activity without a timer", async () => {
	const parent = fakeParent();
	const delivery = createBackgroundDelivery();
	const channel = createParentChannel(parent.pi as never, { isIdle: () => true, delivery });

	await channel.deliver(report("c", "found it"));
	await Promise.resolve();

	expect(parent.sent).toHaveLength(1);
	expect(parent.sent[0]?.message).toMatchObject({
		customType: "pi-subagent-report",
		display: true,
		details: { reports: [report("c", "found it")] },
	});
	// `nextTurn` parks a message until the user speaks again, which is not what a finished child
	// owes the parent.
	expect(parent.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
});

test("reports wait until all registered work finishes", async () => {
	const parent = fakeParent();
	const delivery = createBackgroundDelivery();
	let count = 2;
	let changed = () => {};
	const unregister = delivery.registerSource({
		activeCount: () => count,
		onChange: (listener) => {
			changed = listener;
			return () => {};
		},
	});
	const channel = createParentChannel(parent.pi as never, { isIdle: () => true, delivery });
	await channel.deliver(report("a", "first"));
	count = 1;
	changed();
	await Promise.resolve();
	expect(parent.sent).toHaveLength(0);
	await channel.deliver(report("b", "second"));
	count = 0;
	changed();
	await Promise.resolve();
	expect(parent.sent).toHaveLength(1);
	expect(String(parent.sent[0]?.message.content)).toContain("first");
	expect(String(parent.sent[0]?.message.content)).toContain("second");
	expect(parent.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
	channel.dispose();
	unregister();
});

test("a parent that starts its own run takes held reports into the next step", async () => {
	const parent = fakeParent();
	const delivery = createBackgroundDelivery();
	let idle = true;
	const unregister = delivery.registerSource({ activeCount: () => 1, onChange: () => () => {} });
	const channel = createParentChannel(parent.pi as never, { isIdle: () => idle, delivery });
	await channel.deliver(report("a", "first"));
	await Promise.resolve();
	expect(parent.sent).toHaveLength(0);
	idle = false;
	parent.startRun();
	await Promise.resolve();
	expect(parent.sent).toHaveLength(1);
	expect(parent.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
	channel.dispose();
	unregister();
});

test("a report that arrives while the parent is busy is not held", async () => {
	const parent = fakeParent();
	const delivery = createBackgroundDelivery();
	const channel = createParentChannel(parent.pi as never, { isIdle: () => false, delivery });

	await channel.deliver(report("a", "first"));
	await Promise.resolve();

	expect(parent.sent).toHaveLength(1);
	// Steer enters the next model step rather than waiting until this run ends.
	expect(parent.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
});

test("only a blocked report bypasses idle gating, ordinary reports stay held", async () => {
	const parent = fakeParent();
	const delivery = createBackgroundDelivery();
	delivery.registerSource({ activeCount: () => 1, onChange: () => () => {} });
	let idle = true;
	const channel = createParentChannel(parent.pi as never, { isIdle: () => idle, delivery });
	await channel.deliver(report("a", "ordinary progress"));
	await channel.deliver({ ...report("b", "urgent help"), reason: "blocked" });
	expect(parent.sent).toHaveLength(1);
	expect(parent.sent[0]?.message.content).toContain("urgent help");
	expect(parent.sent[0]?.message.content).not.toContain("ordinary progress");
	idle = false;
	parent.startRun();
	await Promise.resolve();
	expect(parent.sent).toHaveLength(2);
	expect(parent.sent[1]?.message.content).toContain("ordinary progress");
	channel.dispose();
});

test("a cancelled lifecycle cannot wake the parent from a queued check", async () => {
	const parent = fakeParent();
	const controller = new AbortController();
	const channel = createParentChannel(parent.pi as never, {
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
	delivery.registerSource({ activeCount: () => 1, onChange: () => () => {} });
	const channel = createParentChannel(parent.pi as never, { isIdle: () => true, delivery });

	await channel.deliver(report("a", "first"));
	channel.dispose();

	expect(parent.sent).toHaveLength(1);
	expect(parent.sent[0]?.options).toEqual({ triggerTurn: false, deliverAs: "steer" });
	await Promise.resolve();
	expect(parent.sent).toHaveLength(1);
});
