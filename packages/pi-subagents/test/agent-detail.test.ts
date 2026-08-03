import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentDetail,
	agentMarkdownPath,
	createAgentDetail,
	rewriteAgentMarkdown,
	writeAgentMarkdown,
} from "../src/agent-detail.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import type { AgentConfig } from "../src/types.js";

const ENTER = "\r";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const BACKSPACE = "\x7f";
const ESCAPE = "\x1b";

const roots: string[] = [];

const AUTH_REGISTRY = {
	getAvailable: () => [
		{ provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku" },
		{ provider: "cx", id: "gpt-5.6-luna", name: "Luna" },
	],
	hasConfiguredAuth: () => true,
};

afterEach(() => {
	roots.splice(0).forEach((root) => {
		rmSync(root, { recursive: true, force: true });
	});
	vi.restoreAllMocks();
});

function makeAgent(
	name: string,
	content: string,
): { readonly root: string; readonly path: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-detail-"));
	roots.push(root);
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${name}.md`);
	writeFileSync(path, content);
	return { root, path };
}

function configFor(name: string): AgentConfig {
	return {
		name,
		description: "A test agent.",
		extensions: true,
		skills: true,
		systemPrompt: "You are a test agent.",
		promptMode: "replace",
		source: "project",
	};
}

function setup(
	name = "auditor",
	content?: string,
	config = configFor(name),
	registry = AUTH_REGISTRY,
) {
	const { root, path } = makeAgent(name, content ?? defaultContent());
	vi.spyOn(process, "cwd").mockReturnValue(root);
	const notifications: string[] = [];
	const changed: string[] = [];
	const exec = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
	const pi = { exec } as unknown as ExtensionAPI;
	const detail = createAgentDetail(
		pi,
		name,
		config,
		registry,
		() => changed.push("reload"),
		(message) => notifications.push(message),
	);
	return { detail, notifications, changed, exec, registry, path };
}

function setupDefault(name = "Explore") {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-detail-"));
	roots.push(root);
	mkdirSync(join(root, ".pi", "agents"), { recursive: true });
	vi.spyOn(process, "cwd").mockReturnValue(root);
	const notifications: string[] = [];
	const changed: string[] = [];
	const exec = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
	const pi = { exec } as unknown as ExtensionAPI;
	const config: AgentConfig = {
		name,
		description: "Read-only explorer.",
		builtinToolNames: ["read", "bash", "grep", "find", "ls"],
		extensions: true,
		skills: true,
		systemPrompt: "You are a read-only explorer.\n",
		promptMode: "replace",
		isDefault: true,
	};
	const detail = createAgentDetail(
		pi,
		name,
		config,
		AUTH_REGISTRY,
		() => changed.push("reload"),
		(message) => notifications.push(message),
	);
	return { detail, root, notifications, changed, exec };
}

function defaultContent(): string {
	return `---
description: A test agent.
---
You are a test agent.
`;
}

function readContent(path: string): string {
	return readFileSync(path, "utf8");
}

describe("rewriteAgentMarkdown", () => {
	it("preserves unknown frontmatter keys and the body while rewriting managed keys", () => {
		const { path } = makeAgent(
			"auditor",
			`---
description: Old
enabled: true
custom_key: keep-me
---
Body line one.
Body line two.
`,
		);
		rewriteAgentMarkdown(path, {
			display_name: "Auditor",
			description: "New",
			model: "provider/model",
			thinking: "low",
			prompt_mode: "replace",
		});
		expect(readContent(path)).toBe(
			`---
enabled: true
custom_key: keep-me
display_name: "Auditor"
description: "New"
model: "provider/model"
thinking: "low"
prompt_mode: "replace"
---
Body line one.
Body line two.
`,
		);
	});

	it("prepends a frontmatter block to a bare body file", () => {
		const { path } = makeAgent("bare", "Just a prompt.");
		rewriteAgentMarkdown(path, { description: "Just a prompt." });
		expect(readContent(path)).toBe('---\ndescription: "Just a prompt."\n---\nJust a prompt.');
	});

	it("omits unset optional values instead of writing empty keys", () => {
		const { path } = makeAgent("auditor", "---\ndescription: A test agent.\n---\nBody.\n");
		rewriteAgentMarkdown(path, { description: "New" });
		expect(readContent(path)).toBe('---\ndescription: "New"\n---\nBody.\n');
	});
});

describe("agentMarkdownPath", () => {
	it("resolves the project agent file through the current directory", () => {
		const { root, path } = makeAgent("auditor", "---\ndescription: D.\n---\nBody.\n");
		vi.spyOn(process, "cwd").mockReturnValue(root);
		expect(agentMarkdownPath("auditor", "project")).toBe(path);
		expect(agentMarkdownPath("missing", "project")).toBeUndefined();
	});
});

describe("createAgentDetail", () => {
	it("clones a built-in agent into the project agents dir on first save, preserving fields and body", async () => {
		const { detail, root, changed, notifications } = setupDefault();
		const path = join(root, ".pi", "agents", "Explore.md");
		expect(existsSync(path)).toBe(false);
		await detail.handleInput("x"); // identity edit
		await detail.handleInput(ENTER);
		expect(existsSync(path)).toBe(true);
		const content = readContent(path);
		expect(content).toContain('display_name: "x"');
		expect(content).toContain('description: "Read-only explorer."');
		expect(content).not.toContain("enabled:"); // activation is Loadout policy, not Markdown
		expect(content).toContain('prompt_mode: "replace"');
		expect(content).toContain("You are a read-only explorer."); // built-in body preserved
		expect(notifications).toEqual([]);
		expect(changed).toEqual(["reload"]);
		// A second save rewrites the now-existing file without losing the body.
		await detail.handleInput("y");
		await detail.handleInput(ENTER);
		expect(readContent(path)).toContain('display_name: "xy"');
		expect(readContent(path)).toContain("You are a read-only explorer.");
	});

	it("clone preserves the built-in tool allowlist so read-only agents stay read-only", async () => {
		const { detail, root } = setupDefault("Explore");
		const path = join(root, ".pi", "agents", "Explore.md");
		await detail.handleInput("x");
		await detail.handleInput(ENTER);
		expect(readContent(path)).toContain('tools: "read, bash, grep, find, ls"');
		// A reload parses the clone back with the same allowlist, not the
		// "all tools" default that an omitted `tools:` would produce.
		expect(loadCustomAgents(root).get("Explore")?.builtinToolNames).toEqual([
			"read",
			"bash",
			"grep",
			"find",
			"ls",
		]);
	});

	it("writeAgentMarkdown omits tools when the source has no allowlist", () => {
		const { path } = makeAgent("bare", "Body.");
		writeAgentMarkdown(path, { description: "Body." }, "Body.");
		expect(readContent(path)).not.toContain("tools:");
	});

	it("persists an identity text edit on Enter", async () => {
		const { detail, changed, path } = setup();
		await detail.handleInput("x");
		await detail.handleInput(ENTER);
		expect(readContent(path)).toContain('display_name: "x"');
		expect(changed).toEqual(["reload"]);
	});

	it("offers no enabled field: activation stays under the Loadout policy", async () => {
		const { detail } = setup();
		expect(detail.render(100).join("\n")).not.toContain("Enabled:");
	});

	it("cycles thinking with Tab inside the selector and saves both on Enter", async () => {
		const { detail, path } = setup();
		for (let i = 0; i < 2; i++) await detail.handleInput(DOWN); // identity → model
		await detail.handleInput(ENTER); // open selector
		await detail.handleInput(TAB); // inherit → off
		await detail.handleInput(TAB); // off → minimal
		await detail.handleInput(ENTER); // apply + save
		expect(readContent(path)).toContain('thinking: "minimal"');
		expect(readContent(path)).not.toContain("model:");
	});

	it("wraps the thinking cycle back to inherit and omits the key", async () => {
		const { detail, path } = setup();
		for (let i = 0; i < 3; i++) await detail.handleInput(DOWN); // identity → thinking
		await detail.handleInput(ENTER);
		// 8 Tab presses walk inherit → off → … → max → inherit.
		for (let i = 0; i < 8; i++) await detail.handleInput(TAB);
		await detail.handleInput(ENTER);
		expect(readContent(path)).not.toContain("thinking:");
	});

	it("selects a provider/model from the cycler and inherits on the leading option", async () => {
		const { detail, path } = setup();
		for (let i = 0; i < 2; i++) await detail.handleInput(DOWN); // identity → model
		await detail.handleInput(ENTER); // open selector
		await detail.handleInput(DOWN);
		await detail.handleInput(DOWN); // inherit → anthropic/haiku → cx/gpt-5.6-luna
		await detail.handleInput(ENTER);
		expect(readContent(path)).toContain('model: "cx/gpt-5.6-luna"');
		await detail.handleInput(ENTER); // reopen; current option selected
		await detail.handleInput(UP);
		await detail.handleInput(UP); // back to inherit
		await detail.handleInput(ENTER);
		expect(readContent(path)).not.toContain("model:");
	});

	it("keeps a configured fuzzy model as the leading non-inherit cycler option", async () => {
		const { detail } = setup("auditor", undefined, {
			...configFor("auditor"),
			model: "haiku",
		});
		for (let i = 0; i < 2; i++) await detail.handleInput(DOWN);
		await detail.handleInput(ENTER);
		expect(detail.render(60).join("\n")).toMatch(/Model\s+haiku/);
	});

	it("excludes models without configured auth from the cycler options", async () => {
		const { detail } = setup("auditor", undefined, configFor("auditor"), {
			getAvailable: () => [
				{ provider: "anthropic", id: "claude-haiku-4-5" },
				{ provider: "cx", id: "gpt-5.6-luna" },
			],
			hasConfiguredAuth: (model) => model.provider === "anthropic",
		});
		for (let i = 0; i < 2; i++) await detail.handleInput(DOWN);
		await detail.handleInput(ENTER);
		await detail.handleInput(DOWN); // inherit → anthropic/haiku
		expect(detail.render(60).join("\n")).toMatch(/Model\s+anthropic\/claude-haiku-4-5/);
		await detail.handleInput(DOWN); // wraps back to inherit (modulo)
		expect(detail.render(60).join("\n")).toMatch(/Model\s+inherit/);
		expect(detail.render(60).join("\n")).not.toMatch(/Model\s+cx\/gpt-5\.6-luna/);
	});

	it("preserves a configured unauthenticated model as the current option", async () => {
		const { detail, path } = setup(
			"auditor",
			undefined,
			{
				...configFor("auditor"),
				model: "cx/gpt-5.6-luna",
			},
			{
				getAvailable: () => [{ provider: "anthropic", id: "claude-haiku-4-5" }],
				hasConfiguredAuth: (model) => model.provider === "anthropic",
			},
		);
		for (let i = 0; i < 2; i++) await detail.handleInput(DOWN);
		await detail.handleInput(ENTER);
		expect(detail.render(60).join("\n")).toMatch(/Model\s+cx\/gpt-5\.6-luna/); // current option
		await detail.handleInput(DOWN); // → anthropic/claude-haiku-4-5
		expect(detail.render(60).join("\n")).toMatch(/Model\s+anthropic\/claude-haiku-4-5/);
		await detail.handleInput(DOWN); // wraps back to inherit
		expect(detail.render(60).join("\n")).toMatch(/Model\s+inherit/);
		await detail.handleInput(DOWN); // → the preserved current value
		await detail.handleInput(ENTER);
		expect(readContent(path)).toContain('model: "cx/gpt-5.6-luna"');
	});

	it("wraps the model cycler at both ends", async () => {
		const { detail } = setup();
		for (let i = 0; i < 2; i++) await detail.handleInput(DOWN);
		await detail.handleInput(ENTER);
		await detail.handleInput(UP); // inherit wraps up to the last option
		expect(detail.render(60).join("\n")).toMatch(/Model\s+cx\/gpt-5\.6-luna/);
		await detail.handleInput(DOWN); // wraps back to inherit
		expect(detail.render(60).join("\n")).toMatch(/Model\s+inherit/);
	});

	it("Shift+Tab cycles thinking backward", async () => {
		const { detail, path } = setup();
		for (let i = 0; i < 2; i++) await detail.handleInput(DOWN);
		await detail.handleInput(ENTER);
		await detail.handleInput(TAB); // inherit → off
		await detail.handleInput(SHIFT_TAB); // back to inherit
		await detail.handleInput(SHIFT_TAB); // wraps backward to max
		await detail.handleInput(ENTER);
		expect(readContent(path)).toContain('thinking: "max"');
	});

	it("keeps an authenticated current model in alphabetical order", async () => {
		const { detail, path } = setup("auditor", undefined, {
			...configFor("auditor"),
			model: "anthropic/claude-haiku-4-5",
		});
		for (let i = 0; i < 2; i++) await detail.handleInput(DOWN);
		await detail.handleInput(ENTER);
		expect(detail.render(60).join("\n")).toMatch(/Model\s+anthropic\/claude-haiku-4-5/);
		await detail.handleInput(DOWN); // alphabetic order: anthropic… then cx…
		expect(detail.render(60).join("\n")).toMatch(/Model\s+cx\/gpt-5\.6-luna/);
		await detail.handleInput(UP); // back to the current value
		await detail.handleInput(ENTER);
		expect(readContent(path)).toContain('model: "anthropic/claude-haiku-4-5"');
	});

	it("Esc cancels the selector without saving the cycled thinking value", async () => {
		const { detail, path } = setup();
		for (let i = 0; i < 2; i++) await detail.handleInput(DOWN);
		await detail.handleInput(ENTER);
		await detail.handleInput(TAB); // thinking → off in the draft only
		await detail.handleInput(ESCAPE);
		expect(readContent(path)).not.toContain("thinking:");
		expect(detail.render(60).join("\n")).toMatch(/Thinking\s+inherit/);
	});

	it("shows the current model option in place with a fixed row count and no hints", async () => {
		const { detail } = setup();
		for (let i = 0; i < 2; i++) await detail.handleInput(DOWN);
		await detail.handleInput(ENTER);
		const lines = detail.render(18);
		expect(lines).toHaveLength(6);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(18);
		// The open selector shows the current option in place, without hints.
		expect(detail.render(60).join("\n")).toMatch(/Model\s+inherit/);
		expect(detail.render(60).join("\n")).not.toContain("↑/↓");
		await detail.handleInput(DOWN);
		expect(detail.render(60).join("\n")).toMatch(/Model\s+anthropic\/claude-haiku-4-5/);
	});

	it("renders aligned label/value columns with Body 'open in editor' and no informational extras", async () => {
		const { detail } = setup();
		const lines = detail.render(80);
		expect(lines).toHaveLength(6);
		expect(lines.join("\n")).not.toContain("Default agent");
		expect(lines.join("\n")).not.toContain("↑/↓");
		expect(lines.join("\n")).toContain("open in editor");
		// Labels share one left column: "Description" is the widest.
		expect(lines[1]).toMatch(/^ {2}Description {2}/);
	});

	it("applies the accent theme to the focused row", async () => {
		const { detail } = setup();
		const theme = {
			fg: (role: string, value: string) => `[${role}:${value}]`,
			bold: (value: string) => `<${value}>`,
		} as never;
		detail.onThemeChange?.(theme);
		const lines = detail.render(80);
		expect(lines[0]).toContain("[accent:<"); // focused identity row
		expect(lines[1]).not.toContain("[accent:");
		await detail.handleInput(DOWN);
		const moved = detail.render(80);
		expect(moved[1]).toContain("[accent:<");
		expect(moved[0]).not.toContain("[accent:");
	});

	it("removes whole code points with backspace", async () => {
		const { detail, path } = setup();
		await detail.handleInput("中");
		await detail.handleInput("a");
		await detail.handleInput(BACKSPACE);
		await detail.handleInput(ENTER);
		expect(readContent(path)).toContain('display_name: "中"');
	});

	it("flushes pending edits before opening the body editor and reloads afterwards", async () => {
		const { detail, changed, exec, path } = setup();
		await detail.handleInput("draft");
		for (let i = 0; i < 5; i++) await detail.handleInput(DOWN); // identity → body
		await detail.handleInput(ENTER);
		expect(readContent(path)).toContain('display_name: "draft"');
		expect(exec).toHaveBeenCalledWith(process.env.VISUAL ?? process.env.EDITOR ?? "vi", [path]);
		expect(changed).toEqual(["reload", "reload"]);
	});

	it("notifies when the editor exits non-zero", async () => {
		const { detail, exec, notifications } = setup();
		exec.mockResolvedValue({ stdout: "", stderr: "", code: 1 });
		for (let i = 0; i < 5; i++) await detail.handleInput(DOWN);
		await detail.handleInput(ENTER);
		expect(notifications).toEqual(["Editor exited with status 1; the body may be unchanged."]);
	});

	it("clamps selection and truncates rendered lines to the panel width", async () => {
		const { detail } = setup();
		await detail.handleInput(UP);
		const lines = detail.render(18);
		expect(lines[0]?.startsWith("→")).toBe(true); // identity selected
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(18);
	});

	it("refresh replaces the snapshot after an external catalog reload", () => {
		const { detail } = setup();
		expect(detail.render(60).join("\n")).toMatch(/Identity\s+auditor/);
		const next = { ...configFor("auditor"), displayName: "Renamed", model: "cx/gpt-5.6-luna" };
		(detail as AgentDetail).refresh(next);
		const rendered = detail.render(60).join("\n");
		expect(rendered).toMatch(/Identity\s+Renamed/);
		expect(rendered).toMatch(/Model\s+cx\/gpt-5\.6-luna/);
	});
});
