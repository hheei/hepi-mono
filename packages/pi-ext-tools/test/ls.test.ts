import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import { lsCollapsedFooter, parseLsMetrics, registerLsTool } from "../src/ls.js";

describe("ls tool metrics and collapsed view", () => {
	test("parses metrics from various ls outputs", () => {
		expect(parseLsMetrics("")).toEqual({
			total: 0,
			directories: 0,
			files: 0,
			empty: true,
			truncated: false,
		});

		expect(parseLsMetrics("(empty directory)")).toEqual({
			total: 0,
			directories: 0,
			files: 0,
			empty: true,
			truncated: false,
		});

		expect(parseLsMetrics("dist/\nsrc/\ntest/\n")).toEqual({
			total: 3,
			directories: 3,
			files: 0,
			empty: false,
			truncated: false,
		});

		expect(parseLsMetrics("package.json\nREADME.md\n")).toEqual({
			total: 2,
			directories: 0,
			files: 2,
			empty: false,
			truncated: false,
		});

		expect(parseLsMetrics("src/\npackage.json\nREADME.md\n")).toEqual({
			total: 3,
			directories: 1,
			files: 2,
			empty: false,
			truncated: false,
		});

		expect(parseLsMetrics("src/\nREADME.md\n[Truncated: 500 entries]")).toEqual({
			total: 2,
			directories: 1,
			files: 1,
			empty: false,
			truncated: true,
		});
	});

	test("formats collapsed footer correctly", () => {
		const emptyResult: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "(empty directory)" }],
		};
		expect(lsCollapsedFooter(emptyResult, { durationMs: 5 })).toBe("(empty directory) · 5ms");
		expect(lsCollapsedFooter(emptyResult, undefined)).toBe("(empty directory)");

		const mixedResult: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "src/\ntest/\nREADME.md\npackage.json\n" }],
		};
		expect(lsCollapsedFooter(mixedResult, { durationMs: 12 })).toBe(
			"4 entries (2 dirs, 2 files) · 12ms",
		);

		const singleDirResult: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "src/\n" }],
		};
		expect(lsCollapsedFooter(singleDirResult, undefined)).toBe("1 dir");

		const singleFileResult: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "README.md\n" }],
		};
		expect(lsCollapsedFooter(singleFileResult, { durationMs: 3 })).toBe("1 file · 3ms");

		const truncatedResult: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "a/\nb\n[Truncated: 500 entries]" }],
		};
		expect(lsCollapsedFooter(truncatedResult, { durationMs: 40 })).toBe(
			"2 entries (truncated) · 40ms",
		);
	});

	test("registerLsTool registers tool with framed presentation and path summary", () => {
		let registeredTool: ToolDefinition | undefined;
		const mockPi = {
			registerTool: (tool: ToolDefinition) => {
				registeredTool = tool;
			},
		} as unknown as ExtensionAPI;

		registerLsTool(mockPi);
		expect(registeredTool).toBeDefined();
		expect(registeredTool?.name).toBe("ls");
		expect(registeredTool?.renderShell).toBe("self");
	});
});
