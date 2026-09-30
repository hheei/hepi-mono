import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setPromptSection } from "@hheei/pi-ext-core";
import { type DiscoveredAgent, discoverAgents } from "./agent-resolver.js";
import { builtinAgents } from "./builtin-agents.js";

export const TASK_AGENTS_SECTION = "task_agents";

export function formatTaskAgentsContent(agents: readonly DiscoveredAgent[]): string | undefined {
	const taskAgents = agents
		.filter((agent) => agent.frontmatter.interactive !== true && agent.frontmatter.hidden !== true)
		.map((agent) => ({
			name: agent.name,
			description:
				typeof agent.frontmatter.description === "string" &&
				agent.frontmatter.description.trim() !== ""
					? agent.frontmatter.description.trim()
					: "No description provided.",
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

	if (taskAgents.length === 0) return undefined;
	return taskAgents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n");
}

export function registerTaskAgentsPrompt(pi: ExtensionAPI, getCwd: () => string): () => void {
	return pi.on("before_agent_start", async (event) => {
		const sections = event.systemPromptOptions?.sections;
		if (sections === undefined) return;

		let agents: readonly DiscoveredAgent[];
		try {
			agents = await discoverAgents(getCwd());
		} catch {
			agents = builtinAgents();
		}

		const content = formatTaskAgentsContent(agents);
		setPromptSection(sections, TASK_AGENTS_SECTION, content);
	});
}
