import { describe, expect, test } from "bun:test";
import type { TaskState } from "../../../src/modules/todo/model.js";
import { createTodoWidget } from "../../../src/modules/todo/widget.js";
import type { HePiRuntimeContext } from "../../../src/runtime/context.js";
import { visibleWidth } from "../../../src/ui/text.js";

const state = (tasks: TaskState["tasks"]): TaskState => ({ tasks, nextId: 99 });
const task = (
	id: number,
	subject: string,
	status: "pending" | "in_progress" | "completed",
	blockedBy: number[] = [],
) => ({
	id,
	subject,
	status,
	blockedBy,
});

const identityTheme = { fg: (_color: string, text: string) => text };

function recordingTheme() {
	const calls: Array<{ color: string; text: string }> = [];
	return {
		calls,
		fg: (color: string, text: string) => {
			calls.push({ color, text });
			return `<${color}>${text}</${color}>`;
		},
	};
}

interface Harness {
	runtime: HePiRuntimeContext;
	calls: Array<{ key: string; content: unknown; options: unknown }>;
	tui: { requestRender(): void };
	renders(): number;
	tuiRenders(): number;
}
function harness(mode = "tui") {
	const calls: Array<{ key: string; content: unknown; options: unknown }> = [];
	let renders = 0;
	let tuiRenders = 0;
	const tui = { requestRender: () => tuiRenders++ };
	const runtime = {
		ctx: {
			mode,
			ui: {
				setWidget: (key: string, content: unknown, options: unknown) =>
					calls.push({ key, content, options }),
			},
		},
		requestRender: () => renders++,
	} as unknown as HePiRuntimeContext;
	return { runtime, calls, tui, renders: () => renders, tuiRenders: () => tuiRenders };
}

function component(h: Harness, theme = identityTheme) {
	const factory = h.calls.find((call) => typeof call.content === "function")?.content as
		| ((
				tui: Harness["tui"],
				theme: typeof identityTheme,
		  ) => { render(width: number): string[]; invalidate(): void })
		| undefined;
	if (!factory) throw new Error("widget factory not registered");
	return factory(h.tui, theme);
}

describe("todo widget", () => {
	test("is absent outside TUI", () => {
		expect(createTodoWidget(harness("rpc").runtime, state([]))).toBeUndefined();
	});

	test("unregisters empty state", () => {
		const h = harness();
		const widget = createTodoWidget(h.runtime, state([task(1, "x", "pending")]))!;
		widget.refresh(state([]));
		expect(h.calls.at(-1)?.content).toBeUndefined();
	});

	test("registers once and requests render on refresh", () => {
		const h = harness();
		const widget = createTodoWidget(h.runtime, state([task(1, "x", "pending")]))!;
		component(h);
		widget.refresh(state([task(1, "updated", "pending")]));
		expect(h.calls).toHaveLength(1);
		expect(h.renders()).toBe(0);
		expect(h.tuiRenders()).toBe(1);
		expect(component(h).render(80)[1]).toContain("updated");
	});

	test("re-registers after component invalidation", () => {
		const h = harness();
		const widget = createTodoWidget(h.runtime, state([task(1, "x", "pending")]))!;
		component(h).invalidate();
		widget.refresh(state([task(1, "y", "pending")]));
		expect(h.calls).toHaveLength(2);
	});

	test("orders in-progress then pending by id", () => {
		const h = harness();
		createTodoWidget(
			h.runtime,
			state([
				task(4, "pending", "pending"),
				task(3, "working", "in_progress"),
				task(2, "also pending", "pending"),
			]),
		);
		expect(
			component(h)
				.render(80)
				.slice(1)
				.map((line: string) => line.match(/#\d+/)?.[0]),
		).toEqual(["#3", "#2", "#4"]);
	});

	test("renders all-completed header in dim style", () => {
		const h = harness();
		const theme = recordingTheme();
		createTodoWidget(h.runtime, state([task(1, "done", "completed")]));
		expect(component(h, theme).render(80)).toEqual(["<dim>✓</dim> <dim>Todos 1/1</dim>"]);
		expect(theme.calls).toEqual([
			{ color: "dim", text: "✓" },
			{ color: "dim", text: "Todos 1/1" },
		]);
	});

	test("colors header, statuses, ids, blockers, and subjects", () => {
		const h = harness();
		createTodoWidget(
			h.runtime,
			state([task(1, "working", "in_progress"), task(2, "waiting", "pending", [1])]),
		);
		const theme = recordingTheme();
		const lines = component(h, theme).render(200);
		expect(lines[0]).toBe("<accent>●</accent> <text>Todos 0/2</text>");
		expect(lines[1]).toContain("<warning>◐</warning>");
		expect(lines[1]).toContain("<accent>#1</accent>");
		expect(lines[1]).toContain("<text>working</text>");
		expect(lines[2]).toContain("<muted>○</muted>");
		expect(lines[2]).toContain("<accent>#2</accent>");
		expect(lines[2]).toContain("<text>waiting</text>");
		expect(lines[2]).toContain("<warning>⊘</warning> <accent>#1</accent>");
	});

	test("limits rows and reports overflow", () => {
		const h = harness();
		const tasks = Array.from({ length: 8 }, (_, i) => task(i + 1, `task ${i + 1}`, "pending"));
		createTodoWidget(h.runtime, state(tasks));
		const lines = component(h).render(80);
		expect(lines).toHaveLength(8);
		expect(lines.at(-1)).toBe("└─ +2 more");
	});

	test("shows only unresolved blockers", () => {
		const h = harness();
		createTodoWidget(
			h.runtime,
			state([
				task(1, "done", "completed"),
				task(2, "open", "pending", [1, 3, 99]),
				task(3, "blocked", "in_progress"),
			]),
		);
		const lines = component(h).render(80);
		expect(lines.find((line: string) => line.includes("#2"))).toContain("⊘ #3,#99");
	});

	for (const width of [12, 20, 80]) {
		test(`keeps lines within width ${width}`, () => {
			const h = harness();
			createTodoWidget(h.runtime, state([task(1, "界界界 long subject", "pending")]));
			for (const line of component(h).render(width))
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		});
	}

	test("hide only unregisters rendering and refresh shows state again", () => {
		const h = harness();
		const widget = createTodoWidget(h.runtime, state([task(1, "done", "completed")]))!;
		widget.hide();
		expect(h.calls.at(-1)?.content).toBeUndefined();
		widget.refresh(state([task(1, "done", "completed")]));
		expect(typeof h.calls.at(-1)?.content).toBe("function");
	});

	test("disposal is idempotent", () => {
		const h = harness();
		const widget = createTodoWidget(h.runtime, state([task(1, "x", "pending")]))!;
		widget.dispose();
		widget.dispose();
		expect(h.calls.filter((call) => call.content === undefined)).toHaveLength(1);
	});
});
