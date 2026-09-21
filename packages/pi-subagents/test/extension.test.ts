import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { createSubagentsExtension, validateChildEnvironment } from "../src/extension.js";

interface RegisteredTool {
	readonly name: string;
	readonly description: string;
	readonly promptSnippet?: string;
	readonly promptGuidelines?: readonly string[];
}

function inspect(env: NodeJS.ProcessEnv): {
	readonly tools: RegisteredTool[];
	readonly events: string[];
	readonly commands: string[];
} {
	const previous = process.env;
	process.env = env;
	try {
		const tools: RegisteredTool[] = [];
		const events: string[] = [];
		const commands: string[] = [];
		const pi = {
			registerTool(tool: {
				name: string;
				description: string;
				promptSnippet?: string;
				promptGuidelines?: readonly string[];
			}) {
				tools.push(tool);
			},
			registerCommand(name: string) {
				commands.push(name);
			},
			on(event: string) {
				events.push(event);
			},
		} as unknown as ExtensionAPI;
		const manager = { closeLocalConnections: vi.fn() };
		createSubagentsExtension({ createManager: () => manager as never })(pi);
		return { tools, events, commands };
	} finally {
		process.env = previous;
	}
}

describe("extension branch", () => {
	test("registers exactly five parent tools that forbid polling for results", () => {
		const { tools, commands } = inspect({});
		expect(tools.map((tool) => tool.name)).toEqual([
			"spawn_subagent",
			"send_subagent",
			"get_subagent",
			"list_subagents",
			"stop_subagent",
		]);
		expect(commands).toEqual(["attach-subagent"]);
		expect(tools[0]?.description).toContain("Do NOT poll");
		expect(tools[0]?.promptSnippet).toContain("do not poll");
		expect(tools[0]?.promptGuidelines?.join("\n")).toContain("tail session/log files");
		expect(tools[1]?.description).toContain("Do NOT poll");
		expect(tools[2]?.description).toContain("not to wait");
		expect(tools[3]?.description).toContain("not to wait");
	});

	test("child only receives contact_parent and listens for completion nudge events", () => {
		const { tools, events } = inspect({
			PI_SUBAGENTS_PARENT_SESSION_ID: "p",
			PI_SUBAGENTS_CHILD_ID: "c",
			PI_SUBAGENTS_RUNTIME_ID: "r",
			PI_SUBAGENTS_ENDPOINT: "/x",
			PI_SUBAGENTS_TOKEN: "t",
		});
		expect(tools.map((tool) => tool.name)).toEqual(["contact_parent"]);
		expect(tools[0]?.description).toContain("parent is woken");
		expect(events).toEqual(
			expect.arrayContaining(["input", "before_agent_start", "agent_start", "agent_end"]),
		);
	});

	test("partial or malformed identity fails closed", () =>
		expect(() => validateChildEnvironment({ PI_SUBAGENTS_CHILD_ID: "c" })).toThrow(/partial/));
});
