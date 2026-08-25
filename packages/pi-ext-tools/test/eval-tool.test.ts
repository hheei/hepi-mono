import { setTimeout as sleep } from "node:timers/promises";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { clearEvalNestedLive, EvalToolBridge } from "../src/eval/bridge.js";
import { createEvalRuntimeState, startEvalRuntime } from "../src/eval/lifecycle.js";
import { JsRuntime } from "../src/eval/runtime.js";
import {
	createEvalTool,
	EVAL_PROMPT_GUIDELINES,
	EVAL_PROMPT_SNIPPET,
	evalPromptGuidelines,
} from "../src/eval/tool.js";

describe("Eval tool", () => {
	test("maps js/py onto kernel languages and advertises usage", async () => {
		const seen: string[] = [];
		const state = createEvalRuntimeState();
		const stop = startEvalRuntime(state, {
			async runWithHooks(_code, _hooks, _signal, language) {
				seen.push(language ?? "missing");
				return 1;
			},
			dispose() {},
		});
		const tool = createEvalTool(state, new EvalToolBridge(new Map(), () => false));
		try {
			expect(tool.promptSnippet).toBe(EVAL_PROMPT_SNIPPET);
			expect(tool.promptGuidelines).toEqual([...EVAL_PROMPT_GUIDELINES]);
			expect(evalPromptGuidelines("native").join("\n")).toMatch(/edit, and write/u);
			expect(evalPromptGuidelines("apply_patch").join("\n")).toMatch(/apply_patch/u);
			expect(evalPromptGuidelines("apply_patch").join("\n")).not.toMatch(/edit\/write/u);
			expect(evalPromptGuidelines("none").join("\n")).toMatch(/No file-mutation tools/u);
			expect(evalPromptGuidelines("none").join("\n")).not.toMatch(/apply_patch/u);
			await tool.execute("js", { code: "1", language: "js" }, undefined, undefined, {
				cwd: process.cwd(),
			} as never);
			await tool.execute("py", { code: "1", language: "py" }, undefined, undefined, {
				cwd: process.cwd(),
			} as never);
			await tool.execute("default", { code: "1" }, undefined, undefined, {
				cwd: process.cwd(),
			} as never);
			expect(seen).toEqual(["javascript", "python", "javascript"]);
		} finally {
			stop();
		}
	});
	test("rejects a concurrent run instead of sharing its persistent scope", async () => {
		const state = createEvalRuntimeState();
		const stop = startEvalRuntime(state, new JsRuntime(process.cwd()));
		const tool = createEvalTool(state, new EvalToolBridge(new Map(), () => false));
		try {
			const first = tool.execute(
				"first",
				{ code: "await new Promise((resolve) => setTimeout(resolve, 20));" },
				undefined,
				undefined,
				{ cwd: process.cwd() } as never,
			);
			await expect(
				tool.execute("second", { code: "1" }, undefined, undefined, {
					cwd: process.cwd(),
				} as never),
			).rejects.toThrow("already running");
			await first;
		} finally {
			stop();
		}
	});

	test("keeps bounded details and offers oversized transcript through Output", async () => {
		const state = createEvalRuntimeState();
		const stop = startEvalRuntime(state, new JsRuntime(process.cwd()));
		const created: string[] = [];
		const tool = createEvalTool(state, new EvalToolBridge(new Map(), () => false), (text) => {
			created.push(text);
			return { id: "eval-output", persisted: true };
		});
		try {
			const result = await tool.execute(
				"output",
				{ code: 'print("x".repeat(13000));' },
				undefined,
				undefined,
				{ cwd: process.cwd() } as never,
			);
			expect(created).toHaveLength(1);
			expect(result.details.output).toEqual({ id: "eval-output", persisted: true });
			expect(result.details.rows[0]?.kind).toBe("text");
			expect((result.details.rows[0] as { text: string }).text).toContain("truncated");
			const firstContent = result.content[0];
			if (firstContent?.type !== "text") throw new Error("Eval result is missing text content");
			expect(firstContent.text).toContain("output eval-output");
		} finally {
			stop();
		}
	});

	test("preserves transcript details when source fails", async () => {
		const state = createEvalRuntimeState();
		const stop = startEvalRuntime(state, new JsRuntime(process.cwd()));
		const tool = createEvalTool(state, new EvalToolBridge(new Map(), () => false));
		try {
			const result = await tool.execute(
				"failure",
				{ code: 'print("before"); throw new Error("after")' },
				undefined,
				undefined,
				{ cwd: process.cwd() } as never,
			);
			expect(result.details.error).toBe("after");
			expect(result.details.rows).toEqual([
				{ kind: "text", text: "before\n" },
				{ kind: "text", text: "error: after" },
			]);
		} finally {
			stop();
		}
	});

	test("reuses nested tool renderer until live results are cleared", async () => {
		const nested = new Map();
		nested.set("read", {
			name: "read",
			label: "read",
			description: "read",
			parameters: Type.Object({ path: Type.String() }),
			async execute() {
				return { content: [{ type: "text", text: "file-body" }], details: { path: "a.ts" } };
			},
			renderResult: () => new Text("NESTED-BODY", 0, 0),
		});
		const state = createEvalRuntimeState();
		const stop = startEvalRuntime(state, new JsRuntime(process.cwd()));
		const tool = createEvalTool(state, new EvalToolBridge(nested, () => true));
		const theme = { fg: (_role: string, text: string) => text };
		const context = {
			args: { code: 'await tool.read({ path: "a.ts" })' },
			toolCallId: "nested",
			invalidate: () => undefined,
			lastComponent: undefined,
			state: undefined,
			cwd: process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: true,
			showImages: false,
			isError: false,
		};
		try {
			const result = await tool.execute(
				"nested",
				{ code: 'await tool.read({ path: "a.ts" })' },
				undefined,
				undefined,
				{ cwd: process.cwd() } as never,
			);
			const live = tool.renderResult?.(
				result,
				{ expanded: true, isPartial: false },
				theme as never,
				context as never,
			);
			expect(live?.render(80).join("\n")).toContain("NESTED-BODY");
			clearEvalNestedLive();
			const resumed = tool.renderResult?.(
				result,
				{ expanded: true, isPartial: false },
				theme as never,
				context as never,
			);
			const text = resumed?.render(80).join("\n") ?? "";
			expect(text).toContain("read:");
			expect(text).not.toContain("NESTED-BODY");
		} finally {
			stop();
		}
	});

	test("caps persisted rows and streams onUpdate", async () => {
		const state = createEvalRuntimeState();
		const stop = startEvalRuntime(state, new JsRuntime(process.cwd()));
		const created: string[] = [];
		const tool = createEvalTool(state, new EvalToolBridge(new Map(), () => false), (text) => {
			created.push(text);
			return { id: "eval-rows", persisted: true };
		});
		const updates: unknown[] = [];
		try {
			const result = await tool.execute(
				"rows",
				{ code: "for (let i = 0; i < 250; i++) print(String(i));" },
				undefined,
				(update) => {
					updates.push(update);
				},
				{ cwd: process.cwd() } as never,
			);
			expect(result.details.rows.length).toBe(200);
			expect((result.details.rows.at(-1) as { text: string }).text).toContain("omitted");
			expect(created).toHaveLength(1);
			expect(updates.length).toBeGreaterThan(1);
		} finally {
			stop();
		}
	});

	test("drops nested live results from the previous eval", async () => {
		const nested = new Map();
		nested.set("read", {
			name: "read",
			label: "read",
			description: "read",
			parameters: Type.Object({ path: Type.String() }),
			async execute() {
				return { content: [{ type: "text", text: "file-body" }], details: { path: "a.ts" } };
			},
			renderResult: () => new Text("NESTED-BODY", 0, 0),
		});
		const state = createEvalRuntimeState();
		const stop = startEvalRuntime(state, new JsRuntime(process.cwd()));
		const tool = createEvalTool(state, new EvalToolBridge(nested, () => true));
		const theme = { fg: (_role: string, text: string) => text };
		const context = {
			args: { code: 'await tool.read({ path: "a.ts" })' },
			toolCallId: "nested",
			invalidate: () => undefined,
			lastComponent: undefined,
			state: undefined,
			cwd: process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: true,
			showImages: false,
			isError: false,
		};
		try {
			const first = await tool.execute(
				"nested",
				{ code: 'await tool.read({ path: "a.ts" })' },
				undefined,
				undefined,
				{ cwd: process.cwd() } as never,
			);
			expect(
				tool
					.renderResult?.(
						first,
						{ expanded: true, isPartial: false },
						theme as never,
						context as never,
					)
					?.render(80)
					.join("\n"),
			).toContain("NESTED-BODY");
			await tool.execute("next", { code: "1" }, undefined, undefined, {
				cwd: process.cwd(),
			} as never);
			const after = tool.renderResult?.(
				first,
				{ expanded: true, isPartial: false },
				theme as never,
				context as never,
			);
			expect(after?.render(80).join("\n") ?? "").not.toContain("NESTED-BODY");
		} finally {
			stop();
		}
	});

	test("times out kernel-owned work and pauses during nested tools", async () => {
		const nested = new Map();
		nested.set("read", {
			name: "read",
			label: "read",
			description: "read",
			parameters: Type.Object({ path: Type.String() }),
			async execute() {
				await sleep(250);
				return { content: [{ type: "text", text: "ok" }], details: { path: "a.ts" } };
			},
		});
		const state = createEvalRuntimeState();
		const stop = startEvalRuntime(state, new JsRuntime(process.cwd()));
		const tool = createEvalTool(state, new EvalToolBridge(nested, () => true));
		try {
			const nestedResult = await tool.execute(
				"pause",
				{ code: 'await tool.read({ path: "a.ts" }); 1', timeout: 0.05 },
				undefined,
				undefined,
				{ cwd: process.cwd() } as never,
			);
			expect(nestedResult.details.error).toBeUndefined();
			expect(nestedResult.content[0]).toMatchObject({ type: "text" });
			const hung = await tool.execute(
				"timeout",
				{ code: "await new Promise(() => {});", timeout: 0.05 },
				undefined,
				undefined,
				{ cwd: process.cwd() } as never,
			);
			expect(hung.details.error).toMatch(/timed out after 0.05s/u);
		} finally {
			stop();
		}
	});
});
