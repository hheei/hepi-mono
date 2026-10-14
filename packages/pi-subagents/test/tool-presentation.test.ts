import type {
	ExtensionAPI,
	Theme,
	ToolDefinition,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { agentResultText, getToolPresentationProvider, textToolResult } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import type { SubagentManager } from "../src/manager.js";
import { registerParentTools } from "../src/tools.js";

/** No styling, so rendered rows can be asserted as plain text. */
const plainTheme = {
	bg: (_role: string, text: string): string => text,
	fg: (_role: string, text: string): string => text,
	bold: (text: string): string => text,
} as Theme;

function createFakePi(): { pi: ExtensionAPI; tools: ToolDefinition[] } {
	const tools: ToolDefinition[] = [];
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
		getAllTools() {
			return tools;
		},
		getActiveTools() {
			return tools.map((tool) => tool.name);
		},
		setActiveTools() {},
		on() {
			return () => {};
		},
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

function registeredTools(): ToolDefinition[] {
	const { pi, tools } = createFakePi();
	registerParentTools(pi, {} as unknown as SubagentManager, []);
	return tools;
}

function toolNamed(name: string): ToolDefinition {
	const tool = registeredTools().find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`${name} was not registered`);
	return tool;
}

function renderText(component: { render(width: number): string[] }): string {
	return component
		.render(200)
		.map((line) => line.trimEnd())
		.join("\n");
}

function renderCallText(tool: ToolDefinition, args: unknown): string {
	if (tool.renderCall === undefined) throw new Error("missing renderCall");
	return renderText(tool.renderCall(args as never, plainTheme, {} as never));
}

function renderResultText(
	tool: ToolDefinition,
	result: { content: readonly { type: string; text?: string }[]; details?: unknown },
	args: unknown,
): string {
	if (tool.renderResult === undefined) throw new Error("missing renderResult");
	return renderText(
		tool.renderResult(result as never, { expanded: false, isPartial: false }, plainTheme, {
			args,
			isError: false,
		} as never),
	);
}

describe("agent tool presentation providers", () => {
	test("every tool exposes an owned provider", () => {
		for (const name of ["agent_spawn", "agent_send", "agent_get", "agent_stop"]) {
			const renderers: ToolRenderers = toolNamed(name);
			expect(getToolPresentationProvider(renderers)).toBeTypeOf("function");
		}
	});

	test("spawn summary carries agent and title, request the full task", () => {
		const provider = getToolPresentationProvider(toolNamed("agent_spawn"))!;
		const presentation = provider(
			{ agent: "scout", title: "Deck review", task: "Inspect the deck" },
			undefined,
			plainTheme,
		);
		expect(presentation.summary).toBe("scout · Deck review");
		expect(presentation.request).toBe("Inspect the deck");
		expect(presentation.output).toBeUndefined();
	});

	test("spawn result exposes id and path from typed details", () => {
		const provider = getToolPresentationProvider(toolNamed("agent_spawn"))!;
		const presentation = provider(
			{ agent: "scout", title: "Deck review", task: "Inspect the deck" },
			textToolResult('{"id":"agent-3","path":"/tmp/s.jsonl"}', {
				id: "agent-3",
				path: "/tmp/s.jsonl",
			}),
			plainTheme,
		);
		expect(presentation.summary).toBe("scout · Deck review · agent-3");
		expect(presentation.output).toBe("id: agent-3\npath: /tmp/s.jsonl");
	});

	test("send summary carries id and mode, copy keeps the raw message", () => {
		const provider = getToolPresentationProvider(toolNamed("agent_send"))!;
		const presentation = provider(
			{ id: "agent-3", message: "keep going", mode: "steer" },
			textToolResult("Message sent.", undefined),
			plainTheme,
		);
		expect(presentation.summary).toBe("agent-3 · steer");
		expect(presentation.request).toBe("keep going");
		expect(presentation.output).toBe("Message sent.");
		expect(presentation.copy).toEqual({ primary: "keep going", full: "keep going\nMessage sent." });
	});

	test("get renders selected fields instead of raw JSON", () => {
		const provider = getToolPresentationProvider(toolNamed("agent_get"))!;
		const presentation = provider(
			{ id: "agent-3", keys: "status, diagnostic" },
			textToolResult("", { status: "blocked", diagnostic: "Parent decision required" }),
			plainTheme,
		);
		expect(presentation.summary).toBe("agent-3");
		expect(presentation.request).toBe("keys: status, diagnostic");
		expect(presentation.output).toBe("status: blocked\ndiagnostic: Parent decision required");
		expect(presentation.collapsedRows).toEqual(["blocked · diagnostic: Parent decision required"]);
		expect(presentation.output).not.toContain("{");
	});

	test("get level 0 view formats a concise single-line summary with status and progress", () => {
		const provider = getToolPresentationProvider(toolNamed("agent_get"))!;
		const presentation = provider(
			{ id: "agent-3" },
			textToolResult("", {
				status: "running",
				progress: { agent: "scout", turns: 3, tokens: 1540, activeTool: "bash" },
			}),
			plainTheme,
		);
		expect(presentation.collapsedRows).toEqual(["running · scout · 3 turns · 1.5k tok · bash"]);
	});

	test("stop summary carries the id and the confirmation text", () => {
		const provider = getToolPresentationProvider(toolNamed("agent_stop"))!;
		const presentation = provider(
			{ id: "agent-3" },
			textToolResult("Agent stopped.", undefined),
			plainTheme,
		);
		expect(presentation.summary).toBe("agent-3");
		expect(presentation.output).toBe("Agent stopped.");
	});

	test("unknown args narrow to a bare summary without throwing", () => {
		for (const name of ["agent_spawn", "agent_send", "agent_get", "agent_stop"]) {
			const provider = getToolPresentationProvider(toolNamed(name))!;
			expect(() => provider("nonsense", undefined, plainTheme)).not.toThrow();
			expect(() => provider(undefined, undefined, plainTheme)).not.toThrow();
		}
	});
});

describe("native renderer fallback without pi-ext-ui", () => {
	test("spawn renderCall keeps the title, summary and full task", () => {
		const text = renderCallText(toolNamed("agent_spawn"), {
			agent: "scout",
			title: "Deck review",
			task: "Inspect the deck",
		});
		expect(text).toContain("agent_spawn");
		expect(text).toContain("scout · Deck review");
		expect(text).toContain("Inspect the deck");
	});

	test("spawn renderResult keeps the assigned id and path", () => {
		const text = renderResultText(
			toolNamed("agent_spawn"),
			textToolResult('{"id":"agent-3","path":"/tmp/s.jsonl"}', {
				id: "agent-3",
				path: "/tmp/s.jsonl",
			}),
			{ agent: "scout", task: "Inspect the deck" },
		);
		expect(text).toBe("id: agent-3\npath: /tmp/s.jsonl");
	});

	test("send renderResult prints the confirmation and get prints readable fields", () => {
		const sendText = renderResultText(
			toolNamed("agent_send"),
			textToolResult("Message sent.", undefined),
			{ id: "agent-3", message: "keep going" },
		);
		expect(sendText).toBe("Message sent.");
		const getText = renderResultText(
			toolNamed("agent_get"),
			textToolResult("", { status: "running", progress: { agent: "scout", turns: 2 } }),
			{ id: "agent-3" },
		);
		expect(getText).toBe("status: running\nagent: scout\nturns: 2");
	});

	test("errors keep their raw text through the native renderer", () => {
		const tool = toolNamed("agent_stop");
		const result = { content: [{ type: "text" as const, text: "Unknown child" }], isError: true };
		const text = renderText(
			tool.renderResult!(result as never, { expanded: false, isPartial: false }, plainTheme, {
				args: { id: "agent-3" },
				isError: true,
			} as never),
		);
		expect(text).toBe(agentResultText(result as never));
	});
});
