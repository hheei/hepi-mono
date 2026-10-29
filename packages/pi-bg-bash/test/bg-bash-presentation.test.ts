import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getToolPresentationProvider, textToolResult } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";

import { registerBgBashTools } from "../src/bg-bash-tools.js";
import { createBashRuntime } from "../src/session-state.js";
import { renderContextFor, toolFor, toolHost } from "./fixtures/harness.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
const presentationContext = renderContextFor({
	args: {},
	toolCallId: "presentation",
	cwd: "/repo",
});
function registered() {
	const host = toolHost();
	const runtime = createBashRuntime();
	registerBgBashTools(host.pi, runtime.state);
	return host.tools;
}

describe("background Bash owned rendering", () => {
	test("registered tools provide native renderers and optional presentation providers", () => {
		for (const name of ["bg_bash_spawn", "bg_bash_get", "bg_bash_stop"]) {
			const tool = toolFor(registered(), name);
			expect(tool.renderCall).toBeTypeOf("function");
			expect(tool.renderResult).toBeTypeOf("function");
			expect(tool.renderShell).toBe("self");
			expect(getToolPresentationProvider(tool)).toBeTypeOf("function");
		}
	});

	test("spawn preserves multiline command, ID/path and raw clipboard payload", () => {
		const tool = toolFor(registered(), "bg_bash_spawn");
		const args = { command: `printf '你好'\n${"echo long-command\n".repeat(30)}` };
		const details = { id: "bash-1", path: "/session/tasks/bash-1.log" };
		const result = textToolResult(JSON.stringify(details), details);
		const presentation = getToolPresentationProvider(tool)!(
			args,
			result,
			theme,
			presentationContext,
		);
		expect(presentation.summary).toBe("printf '你好' · bash-1");
		expect(presentation.request).toBe(args.command);
		expect(presentation.output).toBe("id: bash-1\npath: /session/tasks/bash-1.log");
		expect(presentation.copy?.primary).toBe(args.command);
		expect(presentation.copy?.full).toContain(JSON.stringify(details));
		const context = renderContextFor({ args, toolCallId: "spawn", cwd: "/repo" });
		for (const width of [12, 100]) {
			const call = tool.renderCall!(args, theme, context).render(width);
			const output = tool.renderResult!(
				result,
				{ expanded: false, isPartial: false },
				theme,
				context,
			).render(width);
			expect([...call, ...output].every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(output.join("")).toContain("bash-1.log");
		}
	});

	test("get displays selected fields and preserves full already-bounded progress output", () => {
		const tool = toolFor(registered(), "bg_bash_get");
		const provider = getToolPresentationProvider(tool)!;
		const output = `begin\n${"x".repeat(3000)}\nend`;
		const result = textToolResult("raw model fields", {
			progress: { path: "/session/task.log", output },
		});
		const presentation = provider(
			{ id: "bash-1", keys: "progress" },
			result,
			theme,
			presentationContext,
		);
		expect(presentation.output).toContain(output);
		expect(presentation.output).not.toContain("status:");
		expect(presentation.output).not.toContain("command:");
		expect(presentation.copy?.primary).toBe("raw model fields");
	});

	test("get level 0 view formats a concise single-line summary", () => {
		const tool = toolFor(registered(), "bg_bash_get");
		const provider = getToolPresentationProvider(tool)!;
		const result = textToolResult("", {
			status: "running",
			progress: { elapsedSeconds: 12 },
		});
		const presentation = provider({ id: "bash-1" }, result, theme, presentationContext);
		expect(presentation.collapsedRows).toEqual(["running · 12s"]);
	});

	test("stop confirmation and errors remain inspectable without pi-ext-ui", () => {
		const tool = toolFor(registered(), "bg_bash_stop");
		const args = { id: "bash-1" };
		const confirmation = textToolResult("Stopped bash-1.", undefined);
		expect(
			getToolPresentationProvider(tool)!(args, confirmation, theme, presentationContext).output,
		).toBe("Stopped bash-1.");
		const result = { ...textToolResult("Cannot stop task", undefined), isError: true };
		const context = renderContextFor({ args, toolCallId: "stop", cwd: "/repo" });
		const output = tool.renderResult!(
			result,
			{ expanded: false, isPartial: false },
			theme,
			context,
		).render(80);
		expect(output.map((line) => line.trimEnd()).join("\n")).toBe("Cannot stop task");
	});
});
