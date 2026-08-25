import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	initTheme,
	type ToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { createOutputRegistry, createToolTui } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import { registerGrepTool } from "../dist/grep.js";

function outputOccurrences(component: ToolExecutionComponent, output: string): number {
	return stripTerminalSequences(component.render(100).join("\n")).split(output).length - 1;
}

describe("grep inaccessible-path ToolExecutionComponent smoke", () => {
	test("renders an incomplete search once across invalidation and resume", async () => {
		initTheme("dark");
		const cwd = await mkdtemp(join(tmpdir(), "hepi-grep-permission-render-"));
		const blocked = join(cwd, "blocked");
		const outputs = createOutputRegistry();
		try {
			await writeFile(join(cwd, "visible.txt"), "needle\n", "utf8");
			await mkdir(blocked);
			await writeFile(join(blocked, "secret.txt"), "needle\n", "utf8");
			await chmod(blocked, 0o000);
			const registered: ToolDefinition[] = [];
			const pi = {
				registerTool(tool: ToolDefinition): void {
					registered.push(tool);
				},
			} as unknown as ExtensionAPI;
			const state = {
				getRuntime: () => undefined,
				getSettings: () => ({ grepEnhancement: false }),
				getOutputs: () => outputs,
				getTargetRuntime: () => undefined,
			} as never;
			const tui = createToolTui();
			registerGrepTool(pi, state, tui);
			const grep = registered[0];
			if (grep === undefined) throw new Error("grep did not register");
			const ui = { requestRender: (): void => undefined } as unknown as TUI;
			tui.beginTrace();
			const component = new ToolExecutionComponent(
				"grep",
				"grep-inaccessible",
				{ pattern: "needle", path: cwd },
				undefined,
				grep,
				ui,
				cwd,
			);
			component.markExecutionStarted();
			const result = await grep.execute(
				"grep-inaccessible",
				{ pattern: "needle", path: cwd },
				undefined,
				undefined,
				{ cwd } as never,
			);
			component.updateResult({ ...result, isError: false });
			const header = stripTerminalSequences(component.render(100).join("\n"));
			expect(header).toContain("! grep");
			expect(outputOccurrences(component, "Results may be incomplete")).toBe(1);
			component.invalidate();
			component.invalidate();
			expect(outputOccurrences(component, "Results may be incomplete")).toBe(1);

			tui.beginTrace();
			const resumed = new ToolExecutionComponent(
				"grep",
				"resumed-grep-inaccessible",
				{ pattern: "needle", path: cwd },
				undefined,
				grep,
				ui,
				cwd,
			);
			resumed.setExpanded(true);
			resumed.updateResult({ ...result, isError: false });
			expect(outputOccurrences(resumed, "Results may be incomplete")).toBe(1);
		} finally {
			await chmod(blocked, 0o700).catch(() => undefined);
			outputs.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
