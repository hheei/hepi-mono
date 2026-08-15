import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	initTheme,
	type ToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { createToolTui } from "@hheei/pi-ext-core";
import { registerApplyPatchTool } from "../src/apply-patch-tool.js";

function render(component: ToolExecutionComponent): string {
	return stripTerminalSequences(component.render(100).join("\n"));
}

function outputOccurrences(component: ToolExecutionComponent, output: string): number {
	return render(component).split(output).length - 1;
}

describe("apply_patch model-time call preview", () => {
	test("updates pending rows from partial arguments before execute starts", async (): Promise<void> => {
		initTheme("dark");
		const registered: ToolDefinition[] = [];
		const pi = {
			registerTool(tool: ToolDefinition): void {
				registered.push(tool);
			},
		} as unknown as ExtensionAPI;
		const tui = createToolTui();
		registerApplyPatchTool(pi, tui);
		const tool = registered[0];
		if (tool === undefined) throw new Error("apply_patch was not registered");
		const root = await mkdtemp(join(tmpdir(), "hepi-apply-patch-call-"));
		try {
			tui.beginTrace();
			const component = new ToolExecutionComponent(
				"apply_patch",
				"apply-patch-call",
				{ patch: "*** Begin Patch\n" },
				undefined,
				tool,
				{ requestRender: (): void => undefined } as unknown as TUI,
				root,
			);
			expect(render(component)).not.toContain("create");
			expect(render(component)).not.toContain(" files");

			component.updateArgs({ patch: "*** Begin Patch\n*** Add File: first.txt\n" });
			expect(render(component)).toContain("apply_patch 1 files");
			expect(render(component)).toContain("○ create first.txt");
			expect(render(component)).not.toContain("+1");

			component.updateArgs({
				patch: "*** Begin Patch\n*** Add File: first.txt\n+one\n*** Add File: second.txt\n",
			});
			expect(render(component)).toContain("apply_patch 2 files");
			expect(render(component)).toContain("○ create first.txt +1");
			expect(render(component)).toContain("○ create second.txt");
			expect(outputOccurrences(component, "○ create first.txt +1")).toBe(1);
			expect(await readdir(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("keeps isolated preview state for parallel tool calls", (): void => {
		initTheme("dark");
		const registered: ToolDefinition[] = [];
		const pi = {
			registerTool(tool: ToolDefinition): void {
				registered.push(tool);
			},
		} as unknown as ExtensionAPI;
		const tui = createToolTui();
		registerApplyPatchTool(pi, tui);
		const tool = registered[0];
		if (tool === undefined) throw new Error("apply_patch was not registered");
		const ui = { requestRender: (): void => undefined } as unknown as TUI;
		tui.beginTrace();
		const left = new ToolExecutionComponent(
			"apply_patch",
			"left",
			{ patch: "*** Begin Patch\n*** Add File: left.txt\n+one\n" },
			undefined,
			tool,
			ui,
			process.cwd(),
		);
		const right = new ToolExecutionComponent(
			"apply_patch",
			"right",
			{ patch: "*** Begin Patch\n*** Delete File: right.txt\n" },
			undefined,
			tool,
			ui,
			process.cwd(),
		);
		expect(render(left)).toContain("○ create left.txt +1");
		expect(render(left)).not.toContain("right.txt");
		expect(render(right)).toContain("○ delete right.txt");
		expect(render(right)).not.toContain("left.txt");
	});

	test("hands the same body slot from call preview to execution progress", async (): Promise<void> => {
		initTheme("dark");
		const registered: ToolDefinition[] = [];
		const pi = {
			registerTool(tool: ToolDefinition): void {
				registered.push(tool);
			},
		} as unknown as ExtensionAPI;
		const tui = createToolTui();
		registerApplyPatchTool(pi, tui);
		const tool = registered[0];
		if (tool === undefined) throw new Error("apply_patch was not registered");
		const root = await mkdtemp(join(tmpdir(), "hepi-apply-patch-handoff-"));
		const patch =
			"*** Begin Patch\n*** Add File: first.txt\n+one\n*** Add File: second.txt\n+two\n*** End Patch";
		try {
			tui.beginTrace();
			const component = new ToolExecutionComponent(
				"apply_patch",
				"apply-patch-handoff",
				{ patch },
				undefined,
				tool,
				{ requestRender: (): void => undefined } as unknown as TUI,
				root,
			);
			expect(render(component)).toContain("○ create first.txt +1");
			expect(outputOccurrences(component, "○ create first.txt +1")).toBe(1);

			component.setArgsComplete();
			component.markExecutionStarted();
			expect(render(component)).toContain("○ create first.txt +1");
			expect(outputOccurrences(component, "create first.txt +1")).toBe(1);

			const result = await tool.execute(
				"apply-patch-handoff",
				{ patch },
				undefined,
				(update) => {
					component.updateResult({ ...update, isError: false }, true);
				},
				{ cwd: root } as never,
			);
			component.updateResult({ ...result, isError: false });
			const finalText = render(component);
			expect(finalText).toContain("✓ create first.txt +1");
			expect(finalText).not.toContain("○ create first.txt +1");
			expect(outputOccurrences(component, "create first.txt +1")).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
