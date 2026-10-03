import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { createToolTui } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import {
	CODEMODE_TOOL_REGISTRATION,
	codemodeFooter,
	codemodeHeaderFacts,
	codemodeWarning,
	registerCodemodeTool,
	renderCodemodeResult,
} from "../src/codemode.js";
import { toolFor, toolHost } from "./fixtures/harness.js";
import { plainTheme } from "./fixtures/theme.js";

const renderContext = { isError: false, isPartial: false, lastComponent: undefined } as never;
const renderCallContext = { isError: false, isPartial: true, lastComponent: undefined } as never;

describe("codemode header facts", () => {
	test("extracts options from // @options: comment on first line", () => {
		const code = `// @options: {"max_output_tokens": 500, "timeout_ms": 30000}
const a = 1;`;
		const facts = codemodeHeaderFacts({ code });
		expect(facts).toContain("(timeout 30s)");
		expect(facts).toContain("(tokens 500)");
	});

	test("extracts timeout and tokens from arguments", () => {
		const facts = codemodeHeaderFacts({
			code: "console.log(1)",
			timeout_ms: 15000,
			max_output_tokens: 200,
		});
		expect(facts).toBe("(timeout 15s) (tokens 200)");
	});

	test("handles timeout in seconds", () => {
		const facts = codemodeHeaderFacts({
			code: "console.log(1)",
			timeout: 5,
		});
		expect(facts).toBe("(timeout 5s)");
	});

	test("returns undefined when no facts exist", () => {
		const facts = codemodeHeaderFacts({
			code: "const x = 123;",
		});
		expect(facts).toBeUndefined();
	});
});

describe("codemode footer", () => {
	test("formats ok and failed nested tool calls with duration", () => {
		const result = {
			content: [{ type: "text" as const, text: "Script completed" }],
			details: {
				calls: [
					{ id: "1", name: "read", status: "ok" as const, durationMs: 40 },
					{ id: "2", name: "bash", status: "error" as const, durationMs: 120 },
					{ id: "3", name: "find", status: "ok" as const, durationMs: 30 },
				],
			},
		};
		const footer = codemodeFooter(result, { durationMs: 2500 });
		expect(footer).toBe("2 ok · 1 failed · 2.5s");
	});

	test("formats model call cost in footer", () => {
		const result = {
			content: [{ type: "text" as const, text: "Script completed" }],
			details: {
				calls: [
					{
						id: "1",
						name: "models.classify",
						status: "ok" as const,
						durationMs: 120,
						cost: 0.0034,
					},
					{
						id: "2",
						name: "models.generateImages",
						status: "ok" as const,
						durationMs: 800,
						cost: 0.04,
					},
				],
			},
		};
		const footer = codemodeFooter(result, { durationMs: 950 });
		expect(footer).toBe("2 ok · 950ms · $0.04");
	});

	test("formats all ok nested calls", () => {
		const result = {
			content: [{ type: "text" as const, text: "Script completed" }],
			details: {
				calls: [
					{ id: "1", name: "read", status: "ok" as const, durationMs: 20 },
					{ id: "2", name: "grep", status: "ok" as const, durationMs: 30 },
				],
			},
		};
		const footer = codemodeFooter(result, { durationMs: 120 });
		expect(footer).toBe("2 ok · 120ms");
	});

	test("formats pure script execution with duration", () => {
		const result = {
			content: [{ type: "text" as const, text: "42" }],
			details: { calls: [] },
		};
		const footer = codemodeFooter(result, { durationMs: 45 });
		expect(footer).toBe("45ms");
	});

	test("formats script failure without calls", () => {
		const result = {
			content: [{ type: "text" as const, text: "Error: boom" }],
			details: { calls: [] },
			isError: true,
		};
		const footer = codemodeFooter(result, { durationMs: 50 });
		expect(footer).toBe("failed · 50ms");
	});
});

describe("codemode warning", () => {
	test("returns true if result is marked isError", () => {
		expect(codemodeWarning({ content: [], isError: true, details: undefined })).toBe(true);
	});

	test("returns true if any nested call failed or was cancelled", () => {
		expect(
			codemodeWarning({
				content: [],
				details: {
					calls: [
						{ id: "1", name: "read", status: "ok" },
						{ id: "2", name: "bash", status: "error" },
					],
				},
			}),
		).toBe(true);

		expect(
			codemodeWarning({
				content: [],
				details: {
					calls: [{ id: "1", name: "read", status: "cancelled" }],
				},
			}),
		).toBe(true);
	});

	test("returns false when all calls succeeded", () => {
		expect(
			codemodeWarning({
				content: [],
				details: {
					calls: [{ id: "1", name: "read", status: "ok" }],
				},
			}),
		).toBe(false);
	});
});

describe("renderCodemodeResult", () => {
	test("renders nested calls and script output, stripping SCRIPT_HEADER", () => {
		const result = {
			content: [
				{
					type: "text" as const,
					text: "Script completed\nWall time 0.1 seconds\nOutput:\n\nHello World!",
				},
			],
			details: {
				calls: [
					{
						id: "1",
						name: "read",
						args: 'path: "file.txt"',
						status: "ok" as const,
						durationMs: 15,
					},
					{
						id: "2",
						name: "bash",
						args: 'command: "false"',
						status: "error" as const,
						durationMs: 50,
						error: "exit status 1",
					},
				],
			},
		};

		const body = renderCodemodeResult(result, { expanded: true, isPartial: false }, plainTheme, {
			isError: false,
		});
		const rendered = body.render(80).join("\n");

		expect(rendered).toContain('✓ read path: "file.txt" 15ms');
		expect(rendered).toContain('✗ bash command: "false" 50ms');
		expect(rendered).toContain("exit status 1");
		expect(rendered).toContain("Hello World!");
		expect(rendered).not.toContain("Script completed");
		expect(rendered).not.toContain("Wall time");
	});

	test("renders call cost and image attachment indicators in Pi 1.0.0", () => {
		const result = {
			content: [
				{
					type: "text" as const,
					text: "Script completed\nWall time 1.2 seconds\nOutput:\nGenerated successfully",
				},
				{
					type: "image" as const,
					data: "base64data",
					mimeType: "image/png",
				},
			],
			details: {
				calls: [
					{
						id: "1",
						name: "models.generateImages",
						args: "provider/model",
						status: "ok" as const,
						durationMs: 1200,
						cost: 0.04,
					},
				],
			},
		};

		const body = renderCodemodeResult(result, { expanded: true, isPartial: false }, plainTheme, {
			isError: false,
		});
		const rendered = body.render(80).join("\n");

		expect(rendered).toContain("✓ models.generateImages provider/model 1.2s $0.04");
		expect(rendered).toContain("[1 image attached]");
		expect(rendered).toContain("Generated successfully");
	});
});

describe("registerCodemodeTool registration & framing", () => {
	test("registers codemode with self shell, model-only exposure, and bash-like frame", () => {
		expect(CODEMODE_TOOL_REGISTRATION.id).toBe("codemode");
		const host = toolHost();
		const tui = createToolTui();
		registerCodemodeTool(host.pi, tui);

		const tool = toolFor(host.tools, "codemode");
		expect(tool.name).toBe("codemode");
		expect(tool.exposure).toBe("model-only");
		expect(tool.defaultActive).toBe(false);
		expect(tool.renderShell).toBe("self");
		expect(tool.parameters).toBeDefined();
		expect(tool.prepareLoadout).toBeDefined();

		// Renders call request (body 上层)
		const callBody = tool.renderCall?.(
			{ code: 'const x = "hello";\nconsole.log(x);' },
			plainTheme,
			renderCallContext,
		);
		expect(callBody).toBeDefined();
		const callLines = callBody?.render(80) ?? [];
		const callText = stripTerminalSequences(callLines.join("\n"));
		expect(callText).toContain('const x = "hello";');

		// Renders result (body 下层)
		const resultBody = tool.renderResult?.(
			{
				content: [
					{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\nhello" },
				],
				details: {
					calls: [{ id: "c-1", name: "read", args: 'path: "a.txt"', status: "ok", durationMs: 12 }],
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			renderContext,
		);
		expect(resultBody).toBeDefined();
		const resultLines = resultBody?.render(80) ?? [];
		const resultText = stripTerminalSequences(resultLines.join("\n"));
		expect(resultText).toContain('✓ read path: "a.txt"');
		expect(resultText).toContain("hello");
		expect(resultText).toContain("1 ok");
	});
});
