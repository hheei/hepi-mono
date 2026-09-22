import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import piSubagentsExtension from "../src/extension.js";
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
