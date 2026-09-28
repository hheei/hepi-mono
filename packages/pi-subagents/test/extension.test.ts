import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import piSubagentsExtension, { createParentChannel } from "../src/extension.js";
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
		expect(tools[1]?.description).toContain("Do NOT poll");
		expect(tools[2]?.description).toContain("not to wait");
		expect(tools[3]?.description).toContain("not to wait");
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

test("a child report reaches the parent as a follow-up, not on the next user message", async () => {
	const sent: { message: unknown; options: unknown }[] = [];
	const report = {
		parentSessionId: "p",
		childId: "c",
		agent: "scout",
		task: "look around",
		status: "done" as const,
		reason: "finished",
		message: "found it",
	};

	await createParentChannel({
		sendMessage(message, options) {
			sent.push({ message, options });
		},
	}).deliver(report);

	expect(sent).toHaveLength(1);
	expect(sent[0]?.message).toMatchObject({
		customType: "pi-subagent-report",
		display: true,
		details: report,
	});
	// `nextTurn` parks a message until the user speaks again, which is not what a finished child
	// owes the parent.
	expect(sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
});
