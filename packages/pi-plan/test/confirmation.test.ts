import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { assertVisibleWidth, stripAnsi } from "../../pi-basics/test/helpers.js";
import type { PlanThinkingLevel } from "../src/confirmation.js";
import { createPlanConfirmationComponent } from "../src/confirmation.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

function harness() {
	const done: unknown[] = [];
	let level: PlanThinkingLevel = "high";
	const models = [
		{ provider: "openai", id: "one", name: "gpt-5.6-sol" },
		{ provider: "anthropic", id: "two", name: "claude-fast" },
	];
	const component = createPlanConfirmationComponent({
		plan: "Build exact confirmation flow",
		model: models[0]!,
		availableModels: models,
		thinkingLevel: level,
		selectModel: async () => true,
		setThinkingLevel: (next) => {
			level = next;
		},
		getThinkingLevel: () => level,
		host: { requestRender() {} },
		theme,
		done: (result) => done.push(result),
	});
	return { component, done };
}

function text(component: { render(width: number): string[] }, width = 90): string {
	return component.render(width).map(stripAnsi).join("\n");
}

describe("plan confirmation", () => {
	test("renders hierarchy, one focus arrow, and cell-safe right panel", () => {
		const { component } = harness();
		const lines = component.render(90);
		const output = lines.map(stripAnsi).join("\n");
		expect(output).toContain("model:");
		expect(output).toContain("→ openai/gpt-5.6-sol (high)");
		expect(output).toContain("action:");
		expect(output).toContain("  implement (compact)");
		expect(output).toContain("  refine");
		expect(output).toContain("Description");
		const descriptionBorder = lines.map(stripAnsi).find((line) => line.includes("╭─ Description"));
		expect(descriptionBorder).toBeDefined();
		const panelStart = descriptionBorder!.indexOf("╭─ Description");
		expect(descriptionBorder!.slice(panelStart).trimEnd()).toHaveLength(44);
		expect(output).toContain("│ openai/one");
		expect(output).toContain("Only models with configured");
		const modelHeading = lines.findIndex((line) => stripAnsi(line).startsWith("model:"));
		expect(modelHeading).toBeGreaterThanOrEqual(0);
		expect(stripAnsi(lines[modelHeading]!)).toContain("Description");
		expect(stripAnsi(lines[0]!)).toContain("plan:");
		expect(stripAnsi(lines[0]!)).not.toContain("Description");
		expect(stripAnsi(lines[modelHeading]!).indexOf("Description")).toBeLessThan(50);
		expect(lines.map(stripAnsi).filter((line) => line.trimStart().startsWith("→ "))).toEqual([
			expect.stringContaining("openai/gpt-5.6-sol"),
		]);
		assertVisibleWidth(lines, 90);
	});

	test("focus changes description and cycles model, thinking, and implementation mode", async () => {
		const { component } = harness();
		expect(text(component)).toContain("openai/one");
		expect(text(component)).toContain("Only models with configured");
		expect(text(component)).toContain("authentication are shown.");
		component.handleInput?.("\x1b[C");
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		expect(text(component)).toContain("anthropic/claude-fast (high)");
		expect(text(component)).toContain("anthropic/two");
		component.handleInput?.("\t");
		expect(text(component)).toContain("(xhigh)");
		component.handleInput?.("\x1b[B");
		expect(text(component)).toContain("Implement using compact");
		component.handleInput?.("\x1b[C");
		expect(text(component)).toContain("implement (new)");
		expect(text(component)).toContain("Start in a new session.");
		component.handleInput?.("\x1b[B");
		expect(text(component)).toContain("Continue planning and");
	});

	test("enter and space select actions; escape cancels", () => {
		const first = harness();
		first.component.handleInput?.("\x1b[B");
		first.component.handleInput?.("\r");
		expect(first.done[0]).toMatchObject({ status: "selected", action: "compact" });

		const second = harness();
		second.component.handleInput?.("\x1b[B");
		second.component.handleInput?.("\x1b[B");
		second.component.handleInput?.(" ");
		expect(second.done[0]).toMatchObject({ status: "selected", action: "refine" });

		const cancelled = harness();
		cancelled.component.handleInput?.("\x1b");
		expect(cancelled.done).toEqual([{ status: "cancelled" }]);
	});
});
