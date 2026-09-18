import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { createSubagentsExtension, validateChildEnvironment } from "../src/extension.js";

const names = (env: NodeJS.ProcessEnv): string[] => {
	const previous = process.env;
	process.env = env;
	try {
		const registered: string[] = [];
		const pi = {
			registerTool(tool: { name: string }) {
				registered.push(tool.name);
			},
			on() {},
		} as unknown as ExtensionAPI;
		const manager = { closeLocalConnections: vi.fn() };
		createSubagentsExtension({ createManager: () => manager as never })(pi);
		return registered;
	} finally {
		process.env = previous;
	}
};

describe("extension branch", () => {
	test("registers exactly five parent tools", () =>
		expect(names({})).toEqual([
			"spawn_subagent",
			"send_subagent",
			"get_subagent",
			"list_subagents",
			"stop_subagent",
		]));
	test("child only receives contact_parent", () =>
		expect(
			names({
				PI_SUBAGENTS_PARENT_SESSION_ID: "p",
				PI_SUBAGENTS_CHILD_ID: "c",
				PI_SUBAGENTS_RUNTIME_ID: "r",
				PI_SUBAGENTS_ENDPOINT: "/x",
				PI_SUBAGENTS_TOKEN: "t",
			}),
		).toEqual(["contact_parent"]));
	test("partial or malformed identity fails closed", () =>
		expect(() => validateChildEnvironment({ PI_SUBAGENTS_CHILD_ID: "c" })).toThrow(/partial/));
});
