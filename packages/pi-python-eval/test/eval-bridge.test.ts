import type { ToolDefinition, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import {
	getToolPresentationProvider,
	registerExtensionHook,
	toolRendererPoint,
} from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import { EvalToolBridge, EvalToolError } from "../src/bridge.js";
import type { EvalRuntimeState } from "../src/lifecycle.js";
import { type EvalToolDetails, PYTHON_EVAL_DETAILS_FORMAT } from "../src/presentation.js";
import { createPythonEvalTool, type EVAL_PARAMETERS, registerPythonEvalTool } from "../src/tool.js";
import { toolHost } from "./fixtures/harness.js";
import { hostError, hostRejection, hostText, nativeHost } from "./fixtures/host.js";

/**
 * The render context is typed by the tool being rendered, so the doubles are read from the real
 * python_eval definition instead of a generic one.
 */
type EvalTool = ToolDefinition<typeof EVAL_PARAMETERS, EvalToolDetails>;
type RenderCallArgs = Parameters<NonNullable<EvalTool["renderCall"]>>;

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as RenderCallArgs[1];
const context = {
	args: {},
	state: {},
	toolCallId: "call",
	cwd: "/repo",
	invalidate() {},
	executionStarted: true,
	argsComplete: true,
	isPartial: false,
	expanded: false,
	showImages: false,
	isError: false,
	lastComponent: undefined,
	durationMs: undefined,
	outputPad: 0,
} as unknown as RenderCallArgs[2];

/** A cell interrupted before the kernel produced a single row. */
const emptyDetails: EvalToolDetails = {
	format: PYTHON_EVAL_DETAILS_FORMAT,
	rows: [],
	durationMs: 0,
};

describe("Eval tool bridge", () => {
	test("dispatches through the host and returns its text", async () => {
		const host = nativeHost(hostText("contents"));
		const traces: unknown[] = [];
		const value = await new EvalToolBridge().call(
			"read",
			{ path: "a.txt" },
			host.context,
			undefined,
			(trace) => traces.push(trace),
		);

		expect(value).toBe("contents");
		expect(host.calls).toEqual([{ name: "read", args: { path: "a.txt" }, signal: undefined }]);
		expect(traces).toHaveLength(1);
		// The trace names the call by the id the host assigned it, so a nested call stays findable.
		expect(traces[0]).toMatchObject({ name: "read", toolCallId: "host-read-1", text: "contents" });
	});

	test("keeps nested image blocks out of the kernel value and forwards them separately", async () => {
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
		const host = nativeHost(async (call) => ({
			toolCall: { type: "toolCall", id: "host-read-image", name: call.name, arguments: {} },
			result: { content: [image], details: { path: "fixture.png" } },
			isError: false,
		}));
		let receivedImages: readonly (typeof image)[] = [];

		const value = await new EvalToolBridge().call(
			"read",
			{ path: "fixture.png" },
			host.context,
			undefined,
			(_trace, images) => {
				receivedImages = images;
			},
		);

		expect(value).toEqual({ path: "fixture.png" });
		expect(receivedImages).toEqual([image]);
	});

	test("returns nested read images as native content blocks on python_eval", async () => {
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
		const host = nativeHost(async (call) => ({
			toolCall: { type: "toolCall", id: "host-read-image", name: call.name, arguments: {} },
			result: { content: [image], details: { path: "fixture.png" } },
			isError: false,
		}));
		const state: EvalRuntimeState = {
			getRuntime: () => ({
				runWithHooks: async (_code, hooks) => {
					await hooks.callTool("read", { path: "fixture.png" });
					return { value: undefined, state: undefined, restarted: false };
				},
				dispose() {},
			}),
		};
		const tool = createPythonEvalTool(state, new EvalToolBridge());

		const result = await tool.execute(
			"python-call",
			{ code: "read fixture.png" },
			undefined,
			() => {},
			host.context,
		);

		expect(result.content.at(-1)).toEqual(image);
		expect(JSON.stringify(result.details)).not.toContain(image.data);
	});

	test("forwards the cell signal so cancellation reaches the nested call", async () => {
		const host = nativeHost(hostText("contents"));
		const controller = new AbortController();
		await new EvalToolBridge().call(
			"read",
			{ path: "a.txt" },
			host.context,
			controller.signal,
			() => {},
		);
		expect(host.calls[0]?.signal).toBe(controller.signal);
	});

	test("returns structuredContent as the kernel value, aligning with codemode toScriptValue", async () => {
		const structured = { output: "line 1\nline 2", exit_code: 0, truncated: false };
		const host = nativeHost(async () => ({
			toolCall: { type: "toolCall", id: "host-bash-1", name: "bash", arguments: {} },
			isError: false,
			result: {
				content: [{ type: "text", text: "line 1\nline 2" }],
				details: {},
				structuredContent: structured,
			},
		}));
		await expect(
			new EvalToolBridge().call("bash", { command: "echo ok" }, host.context, undefined, () => {}),
		).resolves.toEqual(structured);
	});

	test("refuses a tool outside the seven-name whitelist without asking the host", async () => {
		const host = nativeHost(hostText("contents"));
		for (const name of ["python_eval", "todo", "bg_bash_spawn"]) {
			await expect(
				new EvalToolBridge().call(name, {}, host.context, undefined, () => {}),
			).rejects.toThrow(`python_eval cannot call tool: ${name}`);
		}
		expect(host.calls).toEqual([]);
	});

	test("refuses a tool that is not active in this session without asking the host", async () => {
		const host = nativeHost(hostText("contents"));
		const bridge = new EvalToolBridge((name) => name === "read");
		await expect(
			bridge.call("bash", { command: "pwd" }, host.context, undefined, () => {}),
		).rejects.toThrow("python_eval tool is unavailable in the active catalog: bash");
		await expect(
			bridge.call("read", { path: "a.txt" }, host.context, undefined, () => {}),
		).resolves.toBe("contents");
		expect(host.calls).toHaveLength(1);
	});

	test("turns a host-reported error into EvalToolError and keeps its trace", async () => {
		const host = nativeHost(hostError("missing file"));
		const traces: unknown[] = [];
		const failure = await new EvalToolBridge()
			.call("read", { path: "a.txt" }, host.context, undefined, (trace) => traces.push(trace))
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(EvalToolError);
		expect((failure as EvalToolError).trace).toMatchObject({
			name: "read",
			text: "missing file",
			error: "missing file",
		});
		expect(traces).toHaveLength(1);
	});

	test("reports a tool the host cannot dispatch, because the host owns that check", async () => {
		const host = nativeHost(hostError("Unknown tool: read"));
		await expect(
			new EvalToolBridge().call("read", { path: "a.txt" }, host.context, undefined, () => {}),
		).rejects.toBeInstanceOf(EvalToolError);
		expect(host.calls).toHaveLength(1);
	});

	test("wraps a rejected host call with a persisted trace", async () => {
		const host = nativeHost(hostRejection("blocked by permission policy"));
		const traces: { readonly error?: string }[] = [];
		await expect(
			new EvalToolBridge().call("read", { path: "a.txt" }, host.context, undefined, (trace) =>
				traces.push(trace),
			),
		).rejects.toBeInstanceOf(EvalToolError);
		expect(traces[0]?.error).toBe("blocked by permission policy");
	});

	test("the bare definition owns no renderer; registration supplies them", () => {
		const state = { getRuntime: () => undefined } as unknown as EvalRuntimeState;
		const bare = createPythonEvalTool(state, new EvalToolBridge());
		expect(bare.renderCall).toBeUndefined();
		expect(bare.renderResult).toBeUndefined();
		expect(bare.renderShell).toBeUndefined();

		const host = toolHost();
		const registered = registerPythonEvalTool(host.pi, state, new EvalToolBridge());
		expect(registered.renderCall).toBeDefined();
		expect(registered.renderResult).toBeDefined();
		// Self-framed, so a UI resolver can swap in its own renderers without double-framing.
		expect(registered.renderShell).toBe("self");
	});

	test("the native row renders without any UI package installed", () => {
		const host = toolHost();
		const state = { getRuntime: () => undefined } as unknown as EvalRuntimeState;
		const tool = registerPythonEvalTool(host.pi, state, new EvalToolBridge());
		const call = stripTerminalSequences(
			tool.renderCall?.({ code: "x = 1", reset: true }, theme, context).render(80).join("\n") ?? "",
		);
		expect(call.split("\n")[0]?.trimEnd()).toBe("python_eval x = 1 · (reset)");
		expect(call.split("\n")[1]?.trimEnd()).toBe("x = 1");
	});

	test("a UI factory decorates the native renderers, and disposing it restores them", async () => {
		const host = toolHost();
		const state = { getRuntime: () => undefined } as unknown as EvalRuntimeState;
		const tool = registerPythonEvalTool(host.pi, state, new EvalToolBridge());

		let received: ToolRenderers | undefined;
		const handle = registerExtensionHook(
			host.pi,
			toolRendererPoint,
			(name: string, native: ToolRenderers) => {
				if (name !== "python_eval") return native;
				received = native;
				return {
					renderShell: "self",
					renderCall: () => new Text("rich python_eval", 0, 0),
				};
			},
		);
		await handle.ready;

		// Resolution happens per render, so the factory receives the live native renderers.
		const decorated = stripTerminalSequences(
			tool.renderCall?.({ code: "x = 1" }, theme, context).render(80).join("\n") ?? "",
		);
		expect(decorated.trimEnd()).toBe("rich python_eval");
		// The UI factory gets the native renderers, so the typed presentation stays reachable.
		expect(received?.renderCall).toBeDefined();
		expect(getToolPresentationProvider(received)).toBeDefined();

		await handle.dispose();
		expect(
			stripTerminalSequences(
				tool.renderCall?.({ code: "x = 1" }, theme, context).render(80).join("\n") ?? "",
			)
				.split("\n")[0]
				?.trimEnd(),
		).toBe("python_eval x = 1");
	});

	test("the native result row falls back to the plain transcript it produced", () => {
		const host = toolHost();
		const state = { getRuntime: () => undefined } as unknown as EvalRuntimeState;
		const tool = registerPythonEvalTool(host.pi, state, new EvalToolBridge());
		const rendered = stripTerminalSequences(
			tool
				.renderResult?.(
					{ content: [{ type: "text", text: "1\n2" }], details: emptyDetails },
					{ expanded: false, isPartial: false },
					theme,
					context,
				)
				.render(80)
				.join("\n") ?? "",
		);
		expect(rendered.split("\n").map((line) => line.trimEnd())).toEqual(["1", "2"]);
	});
});
