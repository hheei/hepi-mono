import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { discoverAgents, resolveAgent } from "../src/agent-resolver.js";
import {
	builtinAgents,
	builtinAgentToolProblem,
	REVIEWER_REQUIRED_TOOLS,
	SCOUT_REQUIRED_TOOLS,
	WORKER_REQUIRED_TOOLS,
} from "../src/builtin-agents.js";
import { CONTACT_PARENT_TOOL_NAME, type ThinkingLevel } from "../src/domain.js";
import { withTempDir } from "./helpers/tmp-dir.js";

const PARENT = {
	model: { provider: "anthropic", id: "claude-sonnet-4" },
	thinking: "medium" as ThinkingLevel,
};

/**
 * `PI_CODEMODE_MODE=only` short-circuits detection before any file is read, so a host that runs the
 * suite with it exported would make every allowlist below look like it gained `codemode`. These
 * tests state the switch they depend on: off unless the test itself turns it on.
 */
beforeEach(() => {
	vi.stubEnv("PI_CODEMODE_MODE", undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

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

/** The tools a built-in definition declares, in declaration order. */
function builtinTools(name: string): string[] {
	const agent = builtinAgents().find((candidate) => candidate.name === name);
	return String(agent?.frontmatter.tools).split(",");
}

function scoutTools(): string[] {
	return builtinTools("scout");
}

function resolve(
	directory: string,
	name: string,
	bridgeExtensionPath: string,
	extra: {
		readonly skills?: readonly { readonly name: string; readonly path: string }[];
		readonly warnings?: string[];
	} = {},
) {
	return resolveAgent({
		name,
		cwd: join(directory, "project"),
		homeDirectory: join(directory, "home"),
		modelRegistry: MODEL_REGISTRY,
		parent: PARENT,
		bridgeExtensionPath,
		...(extra.skills === undefined ? {} : { skillCatalog: extra.skills }),
		...(extra.warnings === undefined
			? {}
			: { onWarning: (message: string) => extra.warnings?.push(message) }),
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
		// The project definition takes the name, so that built-in never appears; the other built-ins
		// are still the last scope.
		expect(discovered.map((agent) => agent.path)).toEqual([
			pi,
			"<builtin>/scout.md",
			"<builtin>/worker.md",
		]);

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
		// A skills list is a whitelist, so naming one skill also stops inheriting the rest.
		expect(selected.skills).toEqual({ discovery: false, paths: [bridge] });
	});
});

test("a skills list is a whitelist resolved by name against the loaded skills", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		const catalog = [
			{ name: "code-review", path: "/skills/code-review/SKILL.md" },
			{ name: "ponytail-review", path: "/skills/ponytail-review/SKILL.md" },
			{ name: "graphify", path: "/skills/graphify/SKILL.md" },
		];
		const warnings: string[] = [];
		const define = async (skills: string): Promise<void> => {
			await writeAgent(
				directory,
				".pi",
				"narrow",
				`---
name: narrow
${skills}---
Be narrow.
`,
			);
		};

		await define("skills:\n  - code-review\n  - ponytail-review\n");
		const named = await resolve(directory, "narrow", bridge, { skills: catalog, warnings });
		// Named skills arrive as the absolute paths the child needs, and nothing is inherited.
		expect(named.skills).toEqual({
			discovery: false,
			paths: ["/skills/code-review/SKILL.md", "/skills/ponytail-review/SKILL.md"],
		});
		expect(warnings).toEqual([]);

		// `all` and `none` are keywords, not skill names: neither may be looked up or warned about.
		await define("skills: all\n");
		const all = await resolve(directory, "narrow", bridge, { skills: catalog, warnings });
		expect(all.skills).toEqual({ discovery: true, paths: [] });

		await define("skills: none\n");
		const none = await resolve(directory, "narrow", bridge, { skills: catalog, warnings });
		expect(none.skills).toEqual({ discovery: false, paths: [] });
		expect(warnings).toEqual([]);

		// A name the catalog does not know is passed down to Pi so Pi reports it in the subagent panel,
		// without raising a warning in the main agent.
		await define("skills:\n  - code-review\n  - ghost\n");
		const partial = await resolve(directory, "narrow", bridge, { skills: catalog, warnings });
		expect(partial.skills).toEqual({
			discovery: false,
			paths: ["/skills/code-review/SKILL.md", "ghost"],
		});
		expect(warnings).toEqual([]);

		// Without a catalog, names are passed through to Pi to validate and report in subagent.
		const uncatalogued: string[] = [];
		await define("skills:\n  - code-review\n");
		expect((await resolve(directory, "narrow", bridge, { warnings: uncatalogued })).skills).toEqual(
			{ discovery: false, paths: ["code-review"] },
		);
		expect(uncatalogued).toEqual([]);

		// Path-shaped entries keep their old meaning inside the whitelist.
		await define(`skills:\n  - "~"
  - ./extra\n`);
		await mkdir(join(directory, "home"), { recursive: true });
		await mkdir(join(directory, "project", ".pi", "agents", "extra"), { recursive: true });
		const paths = await resolve(directory, "narrow", bridge, { skills: catalog });
		expect(paths.skills).toEqual({
			discovery: false,
			paths: [join(directory, "home"), join(directory, "project", ".pi", "agents", "extra")],
		});
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
		expect(resolved.skills).toEqual({ discovery: false, paths: [home] });
	});
});

test("rejects unknown, unimplemented, and conflicting agent fields", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		const cases: ReadonlyArray<{ readonly definition: string; readonly reason: RegExp }> = [
			{
				definition: "---\nname: labour\ncolour: red\n---\nbody\n",
				reason: /unsupported field colour/u,
			},
			{ definition: "---\nname: labour\nmax_turns: 40\n---\nbody\n", reason: /max_turns/u },
			{
				definition: "---\nname: labour\npreload_skills: true\n---\nbody\n",
				reason: /preload_skills/u,
			},
			{ definition: "---\nname: labour\n---\n\n", reason: /body must not be empty/u },
			{
				definition: "---\nname: labour\nhidden: yes\n---\nbody\n",
				reason: /hidden must be boolean/u,
			},
			{ definition: "---\nname: other\n---\nbody\n", reason: /Unknown agent labour/u },
		];
		for (const item of cases) {
			await writeAgent(directory, ".pi", "labour", item.definition);
			await expect(resolve(directory, "labour", bridge)).rejects.toThrow(item.reason);
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

test("ships a worker and a reviewer that resolve to the tools they declare", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");

		const discovered = await discoverAgents(join(directory, "project"), join(directory, "home"));
		expect(discovered.map((agent) => agent.name)).toEqual(["scout", "worker", "reviewer"]);

		const worker = await resolve(directory, "worker", bridge);
		expect(worker.model).toEqual({ ...PARENT.model, source: "parent" });
		expect(worker.tools).toEqual(builtinTools("worker"));
		// A worker exists to change code, so it must be able to write and to run commands.
		expect(worker.tools).toEqual(expect.arrayContaining([...WORKER_REQUIRED_TOOLS]));

		const reviewer = await resolve(directory, "reviewer", bridge);
		expect(reviewer.tools).toEqual(builtinTools("reviewer"));
		expect(reviewer.tools).toEqual(expect.arrayContaining([...REVIEWER_REQUIRED_TOOLS]));
		// The review skills live in the machine's skill directories, and `--skill` takes a path, so a
		// built-in cannot name them: it keeps skill discovery on instead of pinning a path that only
		// exists on one machine.
		expect(reviewer.skills).toEqual({ discovery: true, paths: [] });
	});
});

test("a built-in cannot be reduced to a role that cannot report", (): void => {
	// Each definition names the tools its promise depends on; a constant that lost one is a
	// build-time bug, and losing the report channel would leave the agent unable to finish.
	for (const [name, required] of [
		["scout", SCOUT_REQUIRED_TOOLS],
		["worker", WORKER_REQUIRED_TOOLS],
		["reviewer", REVIEWER_REQUIRED_TOOLS],
	] as const) {
		const declared = builtinTools(name);
		expect(declared).toEqual(expect.arrayContaining([...required]));
		expect(declared).toContain(CONTACT_PARENT_TOOL_NAME);
		const problem = builtinAgentToolProblem(
			`<builtin>/${name}.md`,
			declared.filter((tool) => tool !== CONTACT_PARENT_TOOL_NAME),
		);
		expect(problem).toMatch(/tools it declares are missing: contact_parent/u);
	}
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
	// The scout mentions contact_parent for urgent blockers, while normal completion delivers text.
	const body = builtinAgents().find((agent) => agent.name === "scout")?.body ?? "";
	expect(body).toContain("contact_parent");
	// A user definition at the same name is a normal agent and is not held to the built-in promise.
	expect(builtinAgentToolProblem("/home/user/.pi/agent/agents/scout.md", [])).toBeUndefined();
});

test("subagent in user domain overwrites built-in with empty body, inheriting built-in settings and body", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");
		// User only specifies model and thinking, with empty body
		await writeAgent(
			directory,
			"home",
			"scout",
			`---\nname: scout\nmodel: openai/gpt-5-codex\nthinking: low\n---\n`,
		);

		const discovered = await discoverAgents(join(directory, "project"), join(directory, "home"));
		const scout = discovered.find((a) => a.name === "scout");
		expect(scout).toBeDefined();
		expect(scout?.enabled).toBe(true);
		expect(scout?.frontmatter.description).toContain("Read-only reconnaissance");
		const builtinBody = builtinAgents().find((agent) => agent.name === "scout")!.body;
		expect(scout?.body).toBe(builtinBody);

		const resolved = await resolve(directory, "scout", bridge);
		expect(resolved.model).toEqual({ provider: "openai", id: "gpt-5-codex", source: "agent" });
		expect(resolved.thinking).toEqual({ level: "low", source: "agent" });
		expect(resolved.agent.instructions).toBe(builtinBody);
		expect(resolved.tools).toContain("read");
		expect(resolved.tools).toContain("contact_parent");
		expect(resolved.enabled).toBe(true);

		// Built-ins with model: inherit (like reviewer and worker) are directly enabled
		const reviewer = discovered.find((a) => a.name === "reviewer");
		expect(reviewer?.enabled).toBe(true);
		const worker = discovered.find((a) => a.name === "worker");
		expect(worker?.enabled).toBe(true);
	});
});

test("built-in scout omits model and is non-compliant (disabled) until configured by user", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const discovered = await discoverAgents(join(directory, "project"), join(directory, "home"));
		const scout = discovered.find((a) => a.name === "scout");
		expect(scout).toBeDefined();
		expect(scout?.enabled).toBe(false);

		const reviewer = discovered.find((a) => a.name === "reviewer");
		expect(reviewer).toBeDefined();
		expect(reviewer?.enabled).toBe(true);
	});
});

test("codemode only detection appends codemode to tools and marks codemodeOnly", async (): Promise<void> => {
	await withTempDir("pi-subagents-agents-", async (directory) => {
		const bridge = join(directory, "bridge.js");
		await writeFile(bridge, "", "utf8");

		// Agent with explicit codemode: only in frontmatter
		await writeAgent(
			directory,
			".agents",
			"code-worker",
			[
				"---",
				"name: code-worker",
				"tools: read,grep,contact_parent",
				"codemode: only",
				"model: openai/gpt-5-codex",
				"---",
				"Do the code work.",
			].join("\n"),
		);

		const resolved = await resolve(directory, "code-worker", bridge);
		expect(resolved.codemodeOnly).toBe(true);
		expect(resolved.tools).toEqual(["read", "grep", "contact_parent", "codemode"]);

		// Agent without codemode field when settings.json has codemode: { mode: "only" }
		const agentDir = join(directory, "home", ".pi", "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ codemode: { mode: "only" } }),
			"utf8",
		);

		await writeAgent(
			directory,
			".agents",
			"plain-worker",
			[
				"---",
				"name: plain-worker",
				"tools: read,contact_parent",
				"model: openai/gpt-5-codex",
				"---",
				"Plain worker.",
			].join("\n"),
		);

		const resolvedPlain = await resolve(directory, "plain-worker", bridge);
		expect(resolvedPlain.codemodeOnly).toBe(true);
		expect(resolvedPlain.tools).toEqual(["read", "contact_parent", "codemode"]);
	});
});

test("detectCodemodeOnly respects project settings over user settings", async () => {
	await withTempDir("test-settings-", async (directory) => {
		const homeDir = join(directory, "home");
		const projDir = join(directory, "project");
		const userSettingsPath = join(homeDir, ".pi", "agent", "settings.json");
		const projSettingsPath = join(projDir, ".pi", "settings.json");

		await mkdir(dirname(userSettingsPath), { recursive: true });
		await mkdir(dirname(projSettingsPath), { recursive: true });

		await writeFile(userSettingsPath, JSON.stringify({ codemode: { mode: "only" } }));
		await writeFile(projSettingsPath, JSON.stringify({ codemode: { mode: "on" } }));

		const { detectCodemodeOnly } = await import("../src/agent-resolver.js");
		expect(detectCodemodeOnly(projDir, homeDir)).toBe(false);
	});
});

test("resolveAgent keeps tools unrestricted when frontmatter omits tools in codemodeOnly mode", async () => {
	await withTempDir("test-tools-", async (directory) => {
		const homeDir = join(directory, "home");
		const projDir = join(directory, "project");
		await writeAgent(directory, ".pi", "open-bot", "---\nname: open-bot\n---\nPrompt body here.\n");

		const resolved = await resolveAgent({
			name: "open-bot",
			cwd: projDir,
			homeDirectory: homeDir,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: "bridge.js",
			skillCatalog: [],
		});

		expect(resolved.tools).toEqual([]);
	});
});

test("resolves mcp configuration with boolean, whitelist, and modifiers", async () => {
	await withTempDir("test-mcp-", async (directory) => {
		const homeDir = join(directory, "home");
		const projDir = join(directory, "project");

		await writeAgent(
			directory,
			".pi",
			"no-mcp-bot",
			"---\nname: no-mcp-bot\nmcp: false\n---\nBody\n",
		);
		await writeAgent(
			directory,
			".pi",
			"whitelist-mcp-bot",
			"---\nname: whitelist-mcp-bot\nmcp: [github, postgres]\n---\nBody\n",
		);
		await writeAgent(
			directory,
			".pi",
			"mod-mcp-bot",
			'---\nname: mod-mcp-bot\nmcp: ["-hindsight"]\n---\nBody\n',
		);

		const resNoMcp = await resolveAgent({
			name: "no-mcp-bot",
			cwd: projDir,
			homeDirectory: homeDir,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: "bridge.js",
		});
		expect(resNoMcp.mcp).toEqual({ enabled: false });

		const resWhitelist = await resolveAgent({
			name: "whitelist-mcp-bot",
			cwd: projDir,
			homeDirectory: homeDir,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: "bridge.js",
		});
		expect(resWhitelist.mcp).toEqual({ enabled: true, servers: ["github", "postgres"] });

		const resMod = await resolveAgent({
			name: "mod-mcp-bot",
			cwd: projDir,
			homeDirectory: homeDir,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: "bridge.js",
		});
		expect(resMod.mcp).toEqual({ enabled: true, excluded: ["hindsight"] });
	});
});

test("tools modifiers merge cleanly onto builtin scout and onto custom agent defaults", async () => {
	await withTempDir("test-tools-mod-", async (directory) => {
		const homeDir = join(directory, "home");
		const projDir = join(directory, "project");

		await writeAgent(
			directory,
			"home",
			"scout",
			'---\nname: scout\nmodel: openai/gpt-5-codex\ntools: ["+codemode", "-ls"]\n---\n',
		);
		const resolvedScout = await resolveAgent({
			name: "scout",
			cwd: projDir,
			homeDirectory: homeDir,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: "bridge.js",
		});
		expect(resolvedScout.tools).toContain("codemode");
		expect(resolvedScout.tools).not.toContain("ls");
		expect(resolvedScout.tools).toContain("read");
		expect(resolvedScout.tools).toContain("contact_parent");
		expect(resolvedScout.mcp).toEqual({ enabled: false });

		await writeAgent(
			directory,
			".pi",
			"custom-mod",
			'---\nname: custom-mod\ntools: ["+codemode", "-bash"]\n---\nBody\n',
		);
		const resolvedCustom = await resolveAgent({
			name: "custom-mod",
			cwd: projDir,
			homeDirectory: homeDir,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: "bridge.js",
		});
		expect(resolvedCustom.tools).toContain("codemode");
		expect(resolvedCustom.tools).not.toContain("bash");
		expect(resolvedCustom.tools).toContain("read");
		expect(resolvedCustom.tools).toContain("contact_parent");
	});
});

test("skills modifiers filter the parent skills catalog", async () => {
	await withTempDir("test-skills-mod-", async (directory) => {
		const homeDir = join(directory, "home");
		const projDir = join(directory, "project");

		await writeAgent(
			directory,
			".pi",
			"skill-mod-bot",
			'---\nname: skill-mod-bot\nskills: ["-code-review"]\n---\nBody\n',
		);
		const resolved = await resolveAgent({
			name: "skill-mod-bot",
			cwd: projDir,
			homeDirectory: homeDir,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: "bridge.js",
			skillCatalog: [
				{ name: "code-review", path: "/skills/code-review" },
				{ name: "test-skill", path: "/skills/test-skill" },
			],
		});
		expect(resolved.skills.discovery).toBe(false);
		expect(resolved.skills.paths).toEqual(["/skills/test-skill"]);
	});
});

test("rejects invalid Pi selection syntax: mixed exact and modifiers or pattern modifiers", async () => {
	await withTempDir("test-selection-err-", async (directory) => {
		const homeDir = join(directory, "home");
		const projDir = join(directory, "project");

		await writeAgent(
			directory,
			".pi",
			"mixed-tools-bot",
			'---\nname: mixed-tools-bot\ntools: [read, "+codemode"]\n---\nBody\n',
		);
		await expect(
			resolveAgent({
				name: "mixed-tools-bot",
				cwd: projDir,
				homeDirectory: homeDir,
				parent: PARENT,
				modelRegistry: MODEL_REGISTRY,
				bridgeExtensionPath: "bridge.js",
			}),
		).rejects.toThrow(/cannot mix exact names with \+name or -name entries/u);

		await writeAgent(
			directory,
			".pi",
			"pattern-mod-bot",
			'---\nname: pattern-mod-bot\nmcp: ["+mcp*"]\n---\nBody\n',
		);
		await expect(
			resolveAgent({
				name: "pattern-mod-bot",
				cwd: projDir,
				homeDirectory: homeDir,
				parent: PARENT,
				modelRegistry: MODEL_REGISTRY,
				bridgeExtensionPath: "bridge.js",
			}),
		).rejects.toThrow(/\+name and -name entries take exact names, not patterns/u);
	});
});

test("applies modifiers in sequential order matching native Pi", async () => {
	await withTempDir("test-seq-mod-", async (directory) => {
		const homeDir = join(directory, "home");
		const projDir = join(directory, "project");

		await writeAgent(
			directory,
			".pi",
			"seq-bot",
			'---\nname: seq-bot\ntools: ["-bash", "+bash"]\n---\nBody\n',
		);
		const resolved = await resolveAgent({
			name: "seq-bot",
			cwd: projDir,
			homeDirectory: homeDir,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: "bridge.js",
		});
		expect(resolved.tools).toContain("bash");
	});
});

test("preserves MCP tool removals into excludeTools when overriding builtin worker", async () => {
	await withTempDir("test-worker-rem-", async (directory) => {
		const homeDir = join(directory, "home");
		const projDir = join(directory, "project");

		await writeAgent(
			directory,
			"home",
			"worker",
			'---\nname: worker\ntools: ["-mcp__github__write"]\n---\n',
		);
		const resolved = await resolveAgent({
			name: "worker",
			cwd: projDir,
			homeDirectory: homeDir,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: "bridge.js",
		});
		expect(resolved.excludeTools).toContain("mcp__github__write");
	});
});

test("disabled builtin MCP base applies complete modifier sequence", async () => {
	await withTempDir("test-scout-rem-", async (directory) => {
		const homeDir = join(directory, "home");
		const projDir = join(directory, "project");

		await writeAgent(
			directory,
			"home",
			"scout",
			'---\nname: scout\nmodel: openai/gpt-5-codex\nmcp: ["+github", "-github"]\n---\n',
		);
		const resolved = await resolveAgent({
			name: "scout",
			cwd: projDir,
			homeDirectory: homeDir,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: "bridge.js",
		});
		expect(resolved.mcp).toEqual({ enabled: false });
	});
});

test("additive MCP modifier on open set does not convert to restrictive whitelist", async () => {
	await withTempDir("test-open-mcp-", async (directory) => {
		const homeDir = join(directory, "home");
		const projDir = join(directory, "project");

		await writeAgent(
			directory,
			".pi",
			"open-mcp-bot",
			'---\nname: open-mcp-bot\nmcp: ["+github"]\n---\nBody\n',
		);
		const resolved = await resolveAgent({
			name: "open-mcp-bot",
			cwd: projDir,
			homeDirectory: homeDir,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: "bridge.js",
		});
		expect(resolved.mcp.enabled).toBe(true);
		expect(resolved.mcp.servers).toBeUndefined();
	});
});

test("shadowed lower-priority agent definitions are skipped without validating", async () => {
	await withTempDir("test-shadow-", async (directory) => {
		const homeDir = join(directory, "home");
		const projDir = join(directory, "project");

		// Higher priority project agent
		await writeAgent(
			directory,
			".pi",
			"worker",
			"---\nname: worker\nmodel: openai/gpt-5-codex\n---\nProject worker body\n",
		);
		// Lower priority user agent with malformed selection
		await writeAgent(
			directory,
			"home",
			"worker",
			'---\nname: worker\ntools: [read, "+invalid"]\n---\nMalformed user body\n',
		);

		const resolved = await resolveAgent({
			name: "worker",
			cwd: projDir,
			homeDirectory: homeDir,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: "bridge.js",
		});
		expect(resolved.agent.instructions).toBe("Project worker body");
	});
});

test("builtin worker override with -bash +bash retains bash without exclusion conflict", async () => {
	await withTempDir("test-worker-seq-", async (directory) => {
		const homeDir = join(directory, "home");
		const projDir = join(directory, "project");

		await writeAgent(
			directory,
			"home",
			"worker",
			'---\nname: worker\ntools: ["-bash", "+bash"]\n---\n',
		);
		const resolved = await resolveAgent({
			name: "worker",
			cwd: projDir,
			homeDirectory: homeDir,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: "bridge.js",
		});
		expect(resolved.tools).toContain("bash");
		expect(resolved.excludeTools).not.toContain("bash");
	});
});

test("open-set mcp with -github +github restores server and does not exclude it", async () => {
	await withTempDir("test-mcp-restore-", async (directory) => {
		const homeDir = join(directory, "home");
		const projDir = join(directory, "project");

		await writeAgent(
			directory,
			".pi",
			"restore-mcp-bot",
			'---\nname: restore-mcp-bot\nmcp: ["-github", "+github"]\n---\nBody\n',
		);
		const resolved = await resolveAgent({
			name: "restore-mcp-bot",
			cwd: projDir,
			homeDirectory: homeDir,
			parent: PARENT,
			modelRegistry: MODEL_REGISTRY,
			bridgeExtensionPath: "bridge.js",
		});
		expect(resolved.mcp.enabled).toBe(true);
		expect(resolved.mcp.excluded).toBeUndefined();
	});
});
