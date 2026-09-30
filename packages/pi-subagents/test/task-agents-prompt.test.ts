import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import type { DiscoveredAgent } from "../src/agent-resolver.js";
import {
	formatTaskAgentsContent,
	registerTaskAgentsPrompt,
	TASK_AGENTS_SECTION,
} from "../src/task-agents-prompt.js";

describe("task-agents-prompt", () => {
	test("formatTaskAgentsContent formats non-interactive, non-hidden agents sorted by name", () => {
		const agents: DiscoveredAgent[] = [
			{
				name: "worker",
				path: "/worker.md",
				body: "",
				frontmatter: { description: "Implementation worker", interactive: false },
			},
			{
				name: "chat",
				path: "/chat.md",
				body: "",
				frontmatter: { description: "Interactive chat", interactive: true },
			},
			{
				name: "hidden-scout",
				path: "/hidden.md",
				body: "",
				frontmatter: { description: "Hidden scout", hidden: true },
			},
			{
				name: "probe",
				path: "/probe.md",
				body: "",
				frontmatter: { description: "Probe diagnostic agent" },
			},
		];

		const content = formatTaskAgentsContent(agents);
		expect(content).toBeDefined();
		expect(content).toBe("- probe: Probe diagnostic agent\n- worker: Implementation worker");
	});

	test("formatTaskAgentsContent returns undefined if no task agents exist", () => {
		const agents: DiscoveredAgent[] = [
			{
				name: "chat",
				path: "/chat.md",
				body: "",
				frontmatter: { description: "Interactive chat", interactive: true },
			},
		];
		expect(formatTaskAgentsContent(agents)).toBeUndefined();
	});

	test("registerTaskAgentsPrompt injects task_agents section on before_agent_start", async () => {
		type Listener = (event: unknown) => Promise<void>;
		let handler: Listener | undefined;

		const pi = {
			on: vi.fn((event: string, fn: Listener) => {
				if (event === "before_agent_start") {
					handler = fn;
				}
				return () => {};
			}),
		} as unknown as ExtensionAPI;

		const unbind = registerTaskAgentsPrompt(pi, () => process.cwd());
		expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
		expect(handler).toBeDefined();

		const sections: Record<string, string> = {};
		const event = {
			systemPromptOptions: {
				sections,
			},
		};

		await handler!(event);

		expect(sections[TASK_AGENTS_SECTION]).toBeDefined();
		expect(sections[TASK_AGENTS_SECTION]).not.toContain("probe:");
		expect(sections[TASK_AGENTS_SECTION]).toContain("scout: Read-only reconnaissance");
		expect(sections[TASK_AGENTS_SECTION]).toContain("worker: Carries out an implementation");
		expect(sections[TASK_AGENTS_SECTION]).toContain("reviewer: Reviews code or a change");

		unbind();
	});
});
