import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { discoverAgents, resolveAgent } from "../src/agent-resolver.js";
import {
	builtinAgents,
	builtinAgentToolProblem,
	SCOUT_REQUIRED_TOOLS,
} from "../src/builtin-agents.js";
import { CONTACT_PARENT_TOOL_NAME, type ThinkingLevel } from "../src/domain.js";
import { withTempDir } from "./helpers/tmp-dir.js";

const PARENT = {
	model: { provider: "anthropic", id: "claude-sonnet-4" },
	thinking: "medium" as ThinkingLevel,
};

/** Only the exact provider/id pairs listed here resolve; everything else is unknown. */
const MODEL_REGISTRY = {
	find(provider: string, modelId: string): unknown | undefined {
		const known = ["anthropic/claude-sonnet-4", "openai/gpt-5-codex", "anthropic/claude-opus-4"];
		return known.includes(`${provider}/${modelId}`) ? { provider, id: modelId } : undefined;
	},
};

async function writeAgent(
	directory: string,
	scope: ".pi" | ".agents" | "home",
	name: string,
	content: string,
): Promise<string> {
	const path =
		scope === "home"
			? join(directory, "home", ".pi", "agent", "agents", `${name}.md`)
			: scope === ".pi"
				? join(directory, "project", ".pi", "agents", `${name}.md`)
				: join(directory, "project", ".agents", "agents", `${name}.md`);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
	return path;
}

/** The tools the built-in scout definition declares, in declaration order. */
function scoutTools(): string[] {
	const scout = builtinAgents().find((agent) => agent.name === "scout");
	return String(scout?.frontmatter.tools).split(",");
}

function resolve(directory: string, name: string, bridgeExtensionPath: string) {
	return resolveAgent({
		name,
		cwd: join(directory, "project"),
		homeDirectory: join(directory, "home"),
		modelRegistry: MODEL_REGISTRY,
		parent: PARENT,
		bridgeExtensionPath,
	});
}

test("agent discovery prefers the most specific scope for a duplicate name", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		await writeAgent(directory, "home", "reviewer", "---\nname: reviewer\n---\nhome body\n");
		await writeAgent(directory, ".agents", "reviewer", "---\nname: reviewer\n---\nagents body\n");
		const pi = await writeAgent(
			directory,
			".pi",
			"reviewer",
			"---\nname: reviewer\n---\npi body\n",
		);

		const discovered = await discoverAgents(join(directory, "project"), join(directory, "home"));
		expect(discovered.map((agent) => agent.path)).toEqual([pi, "<builtin>/scout.md"]);

		const resolved = await resolve(directory, "reviewer", bridge);
		expect(resolved.agent.sourcePath).toBe(pi);
		expect(resolved.agent.instructions).toBe("pi body");
	});
});

test("prefers the project-local agents directory over the shared one", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		await writeAgent(directory, "home", "reviewer", "---\nname: reviewer\n---\nhome body\n");
		const agents = await writeAgent(
			directory,
			".agents",
			"reviewer",
			"---\nname: reviewer\n---\nagents body\n",
		);
		await expect(resolve(directory, "reviewer", bridge)).resolves.toMatchObject({
			agent: { sourcePath: agents, instructions: "agents body" },
		});
	});
});

test("resolves agent overrides and reports where model and thinking came from", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		await writeAgent(
			directory,
			".pi",
			"reviewer",
			[
				"---",
				"name: reviewer",
				"display_name: Code Reviewer",
				"description: Reviews diffs",
				"hidden: true",
				"model: openai/gpt-5-codex",
				"thinking: high",
				"tools: read, grep, contact_parent",
				"---",
				"Review the requested change.",
			].join("\n"),
		);

		const resolved = await resolve(directory, "reviewer", bridge);
		expect(resolved.agent.displayName).toBe("Code Reviewer");
		expect(resolved.agent.description).toBe("Reviews diffs");
		expect(resolved.agent.hidden).toBe(true);
		expect(resolved.model).toEqual({ provider: "openai", id: "gpt-5-codex", source: "agent" });
		expect(resolved.thinking).toEqual({ level: "high", source: "agent" });
		expect(resolved.tools).toEqual(["read", "grep", CONTACT_PARENT_TOOL_NAME]);
		expect(resolved.extensions.paths).toEqual([bridge]);
		expect(resolved.skills).toEqual({ discovery: true, paths: [] });
	});
});

test("inherits parent model and thinking explicitly when the definition omits them", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		await writeAgent(directory, ".pi", "worker", "---\nname: worker\n---\nDo the work.\n");

		const resolved = await resolve(directory, "worker", bridge);
		expect(resolved.model).toEqual({
			provider: "anthropic",
			id: "claude-sonnet-4",
			source: "parent",
		});
		expect(resolved.thinking).toEqual({ level: "medium", source: "parent" });
		expect(resolved.tools).toEqual([]);
	});
});

test("keeps the bridge extension while disabling discovery", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const bridge = join(directory, "bridge.js");
		const extra = join(directory, "extra.js");
		await writeFile(bridge, "", "utf8");
		await writeFile(extra, "", "utf8");
		await writeAgent(
			directory,
			".pi",
			"lean",
			`---\nname: lean\nextensions: false\nskills: false\n---\nBe lean.\n`,
		);

		const resolved = await resolve(directory, "lean", bridge);
		expect(resolved.extensions).toEqual({ discovery: false, paths: [bridge] });
		expect(resolved.skills).toEqual({ discovery: false, paths: [] });

		await writeAgent(
			directory,
			".pi",
			"lean",
			`---\nname: lean\nextensions:\n  - ${extra}\nskills:\n  - ${bridge}\n---\nBe lean.\n`,
		);
		const selected = await resolve(directory, "lean", bridge);
		expect(selected.extensions).toEqual({ discovery: true, paths: [extra, bridge] });
		expect(selected.skills).toEqual({ discovery: true, paths: [bridge] });
	});
});

test("expands a leading ~ in resource selections against the home directory", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const bridge = join(directory, "bridge.js");
		const home = join(directory, "home");
		await writeFile(bridge, "", "utf8");
		await mkdir(join(home, "shared"), { recursive: true });
		await writeFile(join(home, "shared", "extra.js"), "", "utf8");
		await writeAgent(
			directory,
			".pi",
			"lean",
			`---\nname: lean\nextensions:\n  - ~/shared/extra.js\nskills:\n  - "~"\n---\nBe lean.\n`,
		);

		const resolved = await resolve(directory, "lean", bridge);
		// A bare `~` used to be treated as a literal directory name next to the definition.
		expect(resolved.extensions).toEqual({
			discovery: true,
			paths: [join(home, "shared", "extra.js"), bridge],
		});
		expect(resolved.skills).toEqual({ discovery: true, paths: [home] });
	});
});

test("rejects unknown, unimplemented, and conflicting agent fields", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		const cases: ReadonlyArray<{ readonly definition: string; readonly reason: RegExp }> = [
			{
				definition: "---\nname: worker\ncolour: red\n---\nbody\n",
				reason: /unsupported field colour/u,
			},
			{ definition: "---\nname: worker\nmax_turns: 40\n---\nbody\n", reason: /max_turns/u },
			{
				definition: "---\nname: worker\npreload_skills: true\n---\nbody\n",
				reason: /preload_skills/u,
			},
			{ definition: "---\nname: worker\n---\n\n", reason: /body must not be empty/u },
			{
				definition: "---\nname: worker\nhidden: yes\n---\nbody\n",
				reason: /hidden must be boolean/u,
			},
			{
				definition: "---\nname: worker\ninteractive: yes\n---\nbody\n",
				reason: /interactive must be boolean/u,
			},
			{ definition: "---\nname: other\n---\nbody\n", reason: /Unknown agent worker/u },
		];
		for (const item of cases) {
			await writeAgent(directory, ".pi", "worker", item.definition);
			await expect(resolve(directory, "worker", bridge)).rejects.toThrow(item.reason);
		}
	});
});

test("rejects unknown models, invalid thinking, and a disabled contact_parent bridge", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const bridge = join(directory, "bridge.js");
		const missing = join(directory, "missing.js");
		await writeFile(bridge, "", "utf8");
		const cases: ReadonlyArray<{ readonly definition: string; readonly reason: RegExp }> = [
			{ definition: "---\nname: worker\nmodel: nope\n---\nbody\n", reason: /provider\/model-id/u },
			{
				definition: "---\nname: worker\nmodel: openai/gpt-3\n---\nbody\n",
				reason: /unknown model openai\/gpt-3/u,
			},
			{
				definition: "---\nname: worker\nthinking: extreme\n---\nbody\n",
				reason: /thinking is invalid/u,
			},
			{
				definition: "---\nname: worker\nexclude_tools: read, contact_parent\n---\nbody\n",
				reason: /cannot disable the required contact_parent/u,
			},
			{
				definition: "---\nname: worker\ntools: read\n---\nbody\n",
				reason: /must include the required contact_parent/u,
			},
			{
				definition: "---\nname: worker\ntools: read\nexclude_tools: read\n---\nbody\n",
				reason: /both allowed and excluded/u,
			},
			{
				definition: `---\nname: worker\nextensions:\n  - ${missing}\n---\nbody\n`,
				reason: /extensions entry does not exist/u,
			},
		];
		for (const item of cases) {
			await writeAgent(directory, ".pi", "worker", item.definition);
			await expect(resolve(directory, "worker", bridge)).rejects.toThrow(item.reason);
		}
	});
});

test("reports an unknown agent name and an unreadable frontmatter document", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		await expect(resolve(directory, "ghost", bridge)).rejects.toThrow(/Unknown agent ghost/u);
		await writeAgent(directory, ".pi", "broken", "---\nname: broken\n---\n");
		await writeAgent(directory, ".pi", "nameless", "---\ndescription: no name\n---\nbody\n");
		await expect(resolve(directory, "nameless", bridge)).rejects.toThrow(
			/name must be a non-empty string/u,
		);
	});
});

test("defaults interactive to false and freezes an explicit true", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		await writeAgent(directory, ".pi", "worker", "---\nname: worker\n---\nbody\n");
		expect((await resolve(directory, "worker", bridge)).interactive).toBe(false);
		await writeAgent(
			directory,
			".pi",
			"worker",
			"---\nname: worker\ninteractive: true\n---\nbody\n",
		);
		expect((await resolve(directory, "worker", bridge)).interactive).toBe(true);
		await writeAgent(
			directory,
			".pi",
			"worker",
			"---\nname: worker\ninteractive: false\n---\nbody\n",
		);
		expect((await resolve(directory, "worker", bridge)).interactive).toBe(false);
	});
});

test("discovers the built-in scout without writing into the user home", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");

		const discovered = await discoverAgents(join(directory, "project"), join(directory, "home"));
		const scout = discovered.find((agent) => agent.name === "scout");
		expect(scout?.path).toBe("<builtin>/scout.md");

		// It is discoverable but never auto-dispatched, inherits the parent model and thinking,
		// and only lists tools it actually needs.
		const resolved = await resolve(directory, "scout", bridge);
		expect(resolved.model).toEqual({ ...PARENT.model, source: "parent" });
		expect(resolved.thinking).toEqual({ level: "medium", source: "parent" });
		// The resolved allowlist is exactly what the definition declares — no more, no less.
		expect(resolved.tools).toEqual(scoutTools());
	});
});

test("a user definition of scout replaces the built-in one", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		const local = await writeAgent(
			directory,
			".pi",
			"scout",
			`---\nname: scout\ntools: read,${CONTACT_PARENT_TOOL_NAME}\n---\nproject scout\n`,
		);

		const resolved = await resolve(directory, "scout", bridge);
		expect(resolved.agent.sourcePath).toBe(local);
		expect(resolved.agent.instructions).toBe("project scout");
	});
});

test("built-in definitions are parsed by the same frontmatter parser as files on disk", (): void => {
	// A hand-rolled line parser accepted only `key: value`, so a built-in written with a YAML list
	// would have parsed to an empty tool list — the opposite of the read-only promise.
	const defined = builtinAgents().find((agent) => agent.name === "scout");
	expect(defined?.frontmatter.hidden).toBe(false);
	expect(defined?.body).toContain("Read and search only");
});

test("a built-in agent cannot silently inherit every tool", (): void => {
	// An empty `tools` list means "all tools" downstream; the built-in must name its tools, and
	// must name the read/search and report tools the scout promises.
	expect(scoutTools()).toEqual(expect.arrayContaining([...SCOUT_REQUIRED_TOOLS]));
	expect(scoutTools()).toContain(CONTACT_PARENT_TOOL_NAME);
});

test("a built-in agent's resolved tools are checked, not merely its definition", (): void => {
	// The definition naming its tools is not enough: the resolved allowlist is what the child gets,
	// and an empty list means "every tool" in Pi.
	const declared = builtinAgents().find((agent) => agent.name === "scout")?.frontmatter.tools;
	const everything = String(declared).split(",");
	expect(builtinAgentToolProblem("<builtin>/scout.md", everything)).toBeUndefined();
	// A Task child's allowlist gains one extra channel, and nothing else is tolerated.
	expect(
		builtinAgentToolProblem(
			"<builtin>/scout.md",
			[...everything, "submit_task_result"],
			["submit_task_result"],
		),
	).toBeUndefined();
	expect(builtinAgentToolProblem("<builtin>/scout.md", [...everything, "bash"])).toMatch(
		/it would gain tools it never declared: bash/u,
	);
	expect(builtinAgentToolProblem("<builtin>/scout.md", [])).toMatch(/every tool/u);
	// The check compares against what the definition declares, not a hard-coded list, so it keeps
	// working for a future built-in that is not read-only.
	expect(builtinAgentToolProblem("<builtin>/scout.md", ["read", "grep"])).toMatch(
		/tools it declares are missing: find, ls, contact_parent/u,
	);
	// The scout must keep a way to report as well, not only the read tools.
	expect(String(declared)).toContain("contact_parent");
	// It names both report channels: a conversation execution has no submit_task_result tool, so an
	// instruction that only mentions that one would leave the scout unable to finish as asked.
	const body = builtinAgents().find((agent) => agent.name === "scout")?.body ?? "";
	expect(body).toContain("contact_parent");
	expect(body).toContain("submit_task_result");
	// A user definition at the same name is a normal agent and is not held to the built-in promise.
	expect(builtinAgentToolProblem("/home/user/.pi/agent/agents/scout.md", [])).toBeUndefined();
});
