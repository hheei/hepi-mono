import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import piSubagentsExtension, {
	createParentChannel,
	REPORT_MERGE_WINDOW_MS,
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
			"spawn_subagent",
			"send_subagent",
			"get_subagent",
			"list_subagents",
			"stop_subagent",
		]);
		expect(tools[0]?.description).toContain("Do NOT poll");
		expect(tools[0]?.promptSnippet).toContain("do not poll");
		expect(tools[0]?.promptGuidelines?.join("\n")).toContain("tail session/log files");
		// A conversation child is the wrong tool when the answer is needed now, so the prompt says
		// which one is right instead of leaving the model to discover it.
		expect(tools[0]?.promptGuidelines?.join("\n")).toContain("it waits for the result by default");
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

	test("a Task child gets its result channel and no way to delegate further", () => {
		const previous = process.env;
		process.env = {
			...previous,
			PI_SUBAGENTS_PARENT_SESSION_ID: "p",
			PI_SUBAGENTS_CHILD_ID: "c",
			PI_SUBAGENTS_RUNTIME_ID: "r",
			PI_SUBAGENTS_ENDPOINT: "/x",
			PI_SUBAGENTS_TOKEN: "t",
			PI_SUBAGENTS_TASK: JSON.stringify({ softTurns: 60 }),
		};
		try {
			const { pi, tools } = fakePi();
			piSubagentsExtension(pi);
			// Ownership: delegation is a parent-only capability, so a Task child can report but
			// cannot start work nobody would deliver. This branch is where that is enforced.
			expect(tools.map((tool) => tool.name)).toEqual(["contact_parent", "submit_task_result"]);
		} finally {
			process.env = previous;
		}
	});

	test("child only receives contact_parent and listens for completion nudge events", () => {
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
			expect(tools[0]?.description).toContain("parent is woken");
			expect(events).toEqual(
				expect.arrayContaining([
					"input",
					"before_agent_start",
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

test("a child report reaches the parent as a follow-up, not on the next user message", async () => {
	const parent = fakeParent();
	const channel = createParentChannel(parent.pi as never, { isIdle: () => true });

	await channel.deliver(report("c", "found it"));
	vi.advanceTimersByTime(REPORT_MERGE_WINDOW_MS);

	expect(parent.sent).toHaveLength(1);
	expect(parent.sent[0]?.message).toMatchObject({
		customType: "pi-subagent-report",
		display: true,
		details: { reports: [report("c", "found it")] },
	});
	// `nextTurn` parks a message until the user speaks again, which is not what a finished child
	// owes the parent.
	expect(parent.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
});

test("reports that arrive in one idle window leave as a single follow-up", async () => {
	const parent = fakeParent();
	const channel = createParentChannel(parent.pi as never, { isIdle: () => true });

	await channel.deliver(report("a", "first"));
	vi.advanceTimersByTime(REPORT_MERGE_WINDOW_MS - 1_000);
	await channel.deliver(report("b", "second"));
	// A later report never extends the window opened by the first one.
	vi.advanceTimersByTime(1_000);

	expect(parent.sent).toHaveLength(1);
	expect(String(parent.sent[0]?.message.content)).toContain("first");
	expect(String(parent.sent[0]?.message.content)).toContain("second");
	expect(parent.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
});

test("a parent that starts its own run takes the held reports with it", async () => {
	const parent = fakeParent();
	const channel = createParentChannel(parent.pi as never, { isIdle: () => true });

	await channel.deliver(report("a", "first"));
	parent.startRun();

	// Queued for the activity already in flight, so it is read in that run rather than parked.
	expect(parent.sent).toHaveLength(1);
	expect(parent.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
	vi.advanceTimersByTime(REPORT_MERGE_WINDOW_MS);
	expect(parent.sent).toHaveLength(1);
});

test("a report that arrives while the parent is busy is not held", async () => {
	const parent = fakeParent();
	const channel = createParentChannel(parent.pi as never, { isIdle: () => false });

	await channel.deliver(report("a", "first"));

	expect(parent.sent).toHaveLength(1);
	// Busy parents batch queued follow-ups, so this joins the run instead of waiting for the user.
	expect(parent.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
});

test("teardown appends what is still held without waking the parent", async () => {
	const parent = fakeParent();
	const channel = createParentChannel(parent.pi as never, { isIdle: () => true });

	await channel.deliver(report("a", "first"));
	channel.dispose();

	expect(parent.sent).toHaveLength(1);
	expect(parent.sent[0]?.options).toEqual({ triggerTurn: false, deliverAs: "followUp" });
	vi.advanceTimersByTime(REPORT_MERGE_WINDOW_MS);
	expect(parent.sent).toHaveLength(1);
});
