import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
} from "../src/agent-detail.js";
import type { AgentConfig } from "../src/types.js";

const ENTER = "\r";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const SPACE = " ";
const BACKSPACE = "\x7f";

const roots: string[] = [];

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
		enabled: true,
		source: "project",
	};
}

function setup(name = "auditor", content?: string) {
	const { root, path } = makeAgent(name, content ?? defaultContent());
	vi.spyOn(process, "cwd").mockReturnValue(root);
	const notifications: string[] = [];
	const changed: string[] = [];
	const exec = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
	const pi = { exec } as unknown as ExtensionAPI;
	const detail = createAgentDetail(
		pi,
		name,
		configFor(name),
		() => changed.push("reload"),
		(message) => notifications.push(message),
	);
	return { detail, notifications, changed, exec, path };
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
			enabled: false,
			prompt_mode: "replace",
		});
		expect(readContent(path)).toBe(
			`---
custom_key: keep-me
display_name: "Auditor"
description: "New"
model: "provider/model"
thinking: "low"
enabled: false
prompt_mode: "replace"
---
Body line one.
Body line two.
`,
		);
	});

	it("prepends a frontmatter block to a bare body file", () => {
		const { path } = makeAgent("bare", "Just a prompt.");
		rewriteAgentMarkdown(path, { enabled: true });
		expect(readContent(path)).toBe("---\nenabled: true\n---\nJust a prompt.");
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
	it("persists an identity text edit on Enter", async () => {
		const { detail, changed, path } = setup();
		await detail.handleInput("x");
		await detail.handleInput(ENTER);
		expect(readContent(path)).toContain('display_name: "x"');
		expect(changed).toEqual(["reload"]);
	});

	it("persists an enabled toggle immediately on Space", async () => {
		const { detail, path } = setup();
		for (let i = 0; i < 4; i++) await detail.handleInput(DOWN); // identity → enabled
		await detail.handleInput(SPACE);
		expect(readContent(path)).toContain("enabled: false");
	});

	it("cycles thinking levels and persists immediately", async () => {
		const { detail, path } = setup();
		for (let i = 0; i < 3; i++) await detail.handleInput(DOWN); // identity → thinking
		await detail.handleInput(SPACE);
		expect(readContent(path)).toContain('thinking: "off"');
		await detail.handleInput(SPACE);
		expect(readContent(path)).toContain('thinking: "minimal"');
	});

	it("persists a model edit on Enter and rejects malformed refs", async () => {
		const { detail, notifications, path } = setup();
		for (let i = 0; i < 2; i++) await detail.handleInput(DOWN); // identity → model
		await detail.handleInput("garbage");
		await detail.handleInput(ENTER);
		expect(notifications).toEqual(["Agent model must be provider/model; leave empty to inherit"]);
		expect(readContent(path)).not.toContain("garbage");
		for (let i = 0; i < "garbage".length; i++) await detail.handleInput(BACKSPACE);
		await detail.handleInput("cx/gpt-5.6-luna");
		await detail.handleInput(ENTER);
		expect(readContent(path)).toContain('model: "cx/gpt-5.6-luna"');
		expect(notifications).toHaveLength(1);
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
		expect(lines[1]?.startsWith("→")).toBe(true); // identity selected
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(18);
	});

	it("refresh replaces the snapshot after an external catalog reload", () => {
		const { detail } = setup();
		expect(detail.render(60).join("\n")).toContain("Identity: auditor");
		const next = { ...configFor("auditor"), displayName: "Renamed", model: "cx/gpt-5.6-luna" };
		(detail as AgentDetail).refresh(next);
		const rendered = detail.render(60).join("\n");
		expect(rendered).toContain("Identity: Renamed");
		expect(rendered).toContain("Model: cx/gpt-5.6-luna");
	});
});
