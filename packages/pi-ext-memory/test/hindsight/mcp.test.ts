import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkMcpFileOverride,
	HINDSIGHT_MCP_DIRECT_TOOLS,
	HINDSIGHT_MCP_SERVER_NAME,
	HINDSIGHT_MCP_TIMEOUT_SECONDS,
	HINDSIGHT_MCP_TOOL_EXPOSURES,
	isHindsightBusinessError,
	isHindsightWriteTool,
} from "../../src/hindsight/mcp.js";

describe("hindsight MCP tool exposure and write detection", () => {
	it("exposes exactly the 6 direct interactive tools", () => {
		expect([...HINDSIGHT_MCP_DIRECT_TOOLS].sort()).toEqual([
			"get_knowledge_base_tree",
			"get_knowledge_page",
			"recall",
			"reflect",
			"retain",
			"search_knowledge_base",
		]);

		for (const tool of HINDSIGHT_MCP_DIRECT_TOOLS) {
			expect(HINDSIGHT_MCP_TOOL_EXPOSURES[tool]).toBe("direct");
		}
	});

	it("uses 60s timeout matching reflect requirements", () => {
		expect(HINDSIGHT_MCP_TIMEOUT_SECONDS).toBe(60);
	});

	it("identifies read tools vs write tools under mcp__hindsight__ prefix", () => {
		// Read tools
		expect(isHindsightWriteTool("mcp__hindsight__recall")).toBe(false);
		expect(isHindsightWriteTool("mcp__hindsight__reflect")).toBe(false);
		expect(isHindsightWriteTool("mcp__hindsight__get_knowledge_base_tree")).toBe(false);
		expect(isHindsightWriteTool("mcp__hindsight__get_knowledge_page")).toBe(false);
		expect(isHindsightWriteTool("mcp__hindsight__search_knowledge_base")).toBe(false);

		// Write tools
		expect(isHindsightWriteTool("mcp__hindsight__retain")).toBe(true);
		expect(isHindsightWriteTool("mcp__hindsight__sync_retain")).toBe(true);
		expect(isHindsightWriteTool("mcp__hindsight__update_memory")).toBe(true);
		expect(isHindsightWriteTool("mcp__hindsight__invalidate_memory")).toBe(true);
		expect(isHindsightWriteTool("mcp__hindsight__create_knowledge_page")).toBe(true);

		// Conservatively: unknown successful tools invalidate rather than assume never writes
		expect(isHindsightWriteTool("mcp__hindsight__custom_operation")).toBe(true);

		// Other non-hindsight tools
		expect(isHindsightWriteTool("bash")).toBe(false);
		expect(isHindsightWriteTool("mcp__other__retain")).toBe(false);
	});

	it("respects readOnlyHint tool annotation from pi.getAllTools() when present", () => {
		const allTools = [
			{
				name: "mcp__hindsight__custom_read",
				annotations: { readOnlyHint: true },
			},
			{
				name: "mcp__hindsight__custom_mutation",
				annotations: { readOnlyHint: false },
			},
		];

		expect(isHindsightWriteTool("mcp__hindsight__custom_read", allTools)).toBe(false);
		expect(isHindsightWriteTool("mcp__hindsight__custom_mutation", allTools)).toBe(true);
	});
});

describe("isHindsightBusinessError", () => {
	it("detects explicit isError true at top level", () => {
		expect(isHindsightBusinessError({ isError: true })).toBe(true);
		expect(isHindsightBusinessError({ isError: false })).toBe(false);
	});

	it("detects error inside CallToolResult wrapped structuredContent.structuredContent", () => {
		// Native convertMcpResult wraps CallToolResult as structuredContent:
		// { content: [...], structuredContent: { ...businessPayload... }, isError: false }
		const callToolResult = {
			content: [{ type: "text", text: "Something happened" }],
			structuredContent: {
				status: "error",
				message: "bank not ready",
			},
			isError: false,
		};

		expect(isHindsightBusinessError({ isError: false, structuredContent: callToolResult })).toBe(
			true,
		);

		const successResult = {
			content: [{ type: "text", text: "Retained" }],
			structuredContent: {
				status: "ok",
				success: true,
			},
			isError: false,
		};
		expect(isHindsightBusinessError({ isError: false, structuredContent: successResult })).toBe(
			false,
		);
	});

	it("detects error in raw untruncated content of CallToolResult (structuredContent.content)", () => {
		const callToolResult = {
			content: [
				{
					type: "text",
					text: JSON.stringify({ error: "Memory quota exceeded", success: false }),
				},
			],
			isError: false,
		};

		expect(isHindsightBusinessError({ isError: false, structuredContent: callToolResult })).toBe(
			true,
		);
	});

	it("detects JSON error strings in outer model content", () => {
		expect(
			isHindsightBusinessError({
				isError: false,
				content: [{ type: "text", text: JSON.stringify({ status: "error", message: "fail" }) }],
			}),
		).toBe(true);

		expect(
			isHindsightBusinessError({
				isError: false,
				content: [{ type: "text", text: JSON.stringify({ error: "bank not found" }) }],
			}),
		).toBe(true);

		expect(
			isHindsightBusinessError({
				isError: false,
				content: [{ type: "text", text: "Successfully retained memory" }],
			}),
		).toBe(false);
	});
});

describe("checkMcpFileOverride", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = `${tmpdir()}/hindsight-mcp-override-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns undefined when no mcp.json defines hindsight", async () => {
		expect(await checkMcpFileOverride(cwd, agentDir)).toBeUndefined();
	});

	it("detects override in agent mcp.json", async () => {
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { [HINDSIGHT_MCP_SERVER_NAME]: { url: "http://other" } } }),
			"utf-8",
		);
		expect(await checkMcpFileOverride(cwd, agentDir)).toBe("overridden by agent mcp.json");
	});

	it("detects override in project .pi/mcp.json", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { [HINDSIGHT_MCP_SERVER_NAME]: { url: "http://other" } } }),
			"utf-8",
		);
		expect(await checkMcpFileOverride(cwd, agentDir)).toBe("overridden by .pi/mcp.json");
	});
});
