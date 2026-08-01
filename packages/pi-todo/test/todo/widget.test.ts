import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { suspendHepiWidgets } from "@hheei/pi-ext-core";
import type { TaskState } from "../../src/model.js";
import { createTodoWidget as createManagedTodoWidget } from "../../src/widget.js";

const state = (tasks: TaskState["tasks"]): TaskState => ({ tasks, nextId: 99 });
const task = (
	id: number,
	subject: string,
	status: "pending" | "in_progress" | "blocked" | "completed" | "suppressed",
) => ({ id, subject, status });

const identityTheme = {
	fg: (_color: string, text: string) => text,
	strikethrough: (text: string) => `~${text}~`,
};

function recordingTheme() {
	const calls: Array<{ color: string; text: string }> = [];
	return {
		calls,
		fg: (color: string, text: string) => {
			calls.push({ color, text });
			return `<${color}>${text}</${color}>`;
		},
		strikethrough: (text: string) => `~${text}~`,
	};
}

interface Harness {
	pi: ExtensionAPI;
	runtime: ExtensionContext;
	signal: AbortSignal;
	calls: Array<{ key: string; content: unknown; options: unknown }>;
	tui: { requestRender(force?: boolean): void };
	renders(): number;
	tuiRenders(): number;
}
function harness(mode = "tui") {
	const calls: Array<{ key: string; content: unknown; options: unknown }> = [];
	const renders = 0;
	const controller = new AbortController();
	const pi = { events: {} } as unknown as ExtensionAPI;
	let tuiRenders = 0;
	const tui = { requestRender: () => tuiRenders++ };
	const runtime = {
		mode,
		ui: {
			setWidget: (key: string, content: unknown, options: unknown) =>
				calls.push({ key, content, options }),
		},
	} as unknown as ExtensionContext;
	return {
		pi,
		runtime,
		signal: controller.signal,
		calls,
		tui,
		renders: () => renders,
		tuiRenders: () => tuiRenders,
	};
}

function createTodoWidget(
	h: Harness,
	initialState: TaskState,
): ReturnType<typeof createManagedTodoWidget> {
	return createManagedTodoWidget(h.pi, h.runtime, h.signal, initialState);
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
		const h = harness("rpc");
		expect(createTodoWidget(h, state([]))).toBeUndefined();
	});

	test("unregisters empty state", () => {
		const h = harness();
		const widget = createTodoWidget(h, state([task(1, "x", "pending")]))!;
		widget.refresh(state([]));
		expect(h.calls.at(-1)?.content).toBeUndefined();
	});

	test("registers once and requests render on refresh", () => {
		const h = harness();
		const widget = createTodoWidget(h, state([task(1, "x", "pending")]))!;
		component(h);
		widget.refresh(state([task(1, "updated", "pending")]));
		expect(h.calls).toHaveLength(1);
		expect(h.renders()).toBe(0);
		expect(h.tuiRenders()).toBe(1);
		expect(component(h).render(80)[1]).toContain("updated");
	});

	test("re-registers after component invalidation", () => {
		const h = harness();
		const widget = createTodoWidget(h, state([task(1, "x", "pending")]))!;
		component(h).invalidate();
		widget.refresh(state([task(1, "y", "pending")]));
		expect(h.calls).toHaveLength(2);
	});

	test("is suspended and restored through the core Settings lease", () => {
		const h = harness();
		createTodoWidget(h, state([task(1, "x", "pending")]));
		const lease = suspendHepiWidgets(h.pi);
		expect(h.calls.at(-1)?.content).toBeUndefined();
		lease.release();
		expect(typeof h.calls.at(-1)?.content).toBe("function");
	});

	test("orders in-progress, pending, then temporary blocked tasks", () => {
		const h = harness();
		createTodoWidget(
			h,
			state([
				task(4, "pending", "pending"),
				task(3, "working", "in_progress"),
				task(2, "blocked", "blocked"),
				task(1, "also pending", "pending"),
			]),
		);
		const lines = component(h).render(80);
		expect(lines.slice(1).map((line: string) => line.match(/#\d+/)?.[0])).toEqual([
			"#3",
			"#1",
			"#4",
			"#2",
		]);
		expect(lines.find((line: string) => line.includes("#2"))).toContain("⊘ #2 ~blocked~");
	});

	test("does not register historical completed tasks", () => {
		const h = harness();
		createTodoWidget(h, state([task(1, "done", "completed")]));
		expect(h.calls).toEqual([]);
	});

	test("colors header, statuses, ids, and subjects", () => {
		const h = harness();
		createTodoWidget(h, state([task(1, "working", "in_progress"), task(2, "waiting", "pending")]));
		const theme = recordingTheme();
		const lines = component(h, theme).render(200);
		expect(lines[0]).toBe("<accent>●</accent> <text>Todos (0/2)</text>");
		expect(lines[1]).toContain("<warning>◐</warning>");
		expect(lines[1]).toContain("<accent>#1</accent>");
		expect(lines[1]).toContain("<text>working</text>");
		expect(lines[2]).toContain("<muted>○</muted>");
		expect(lines[2]).toContain("<accent>#2</accent>");
		expect(lines[2]).toContain("<text>waiting</text>");
	});

	test("limits rows and reports overflow", () => {
		const h = harness();
		const tasks = Array.from({ length: 8 }, (_, i) => task(i + 1, `task ${i + 1}`, "pending"));
		createTodoWidget(h, state(tasks));
		const lines = component(h).render(80);
		expect(lines).toHaveLength(9);
		expect(lines.at(-2)).toBe("└─ +2 more");
		expect(lines.at(-1)).toBe("");
	});

	test("suppressed tasks are hidden and an all-suppressed state unregisters", () => {
		const h = harness();
		const widget = createTodoWidget(
			h,
			state([task(1, "hidden", "suppressed"), task(2, "visible", "pending")]),
		)!;
		const lines = component(h).render(80);
		expect(lines.some((line: string) => line.includes("#1"))).toBe(false);
		expect(lines.some((line: string) => line.includes("#2"))).toBe(true);
		widget.refresh(state([task(1, "hidden", "suppressed")]));
		expect(h.calls.at(-1)?.content).toBeUndefined();
	});

	for (const width of [12, 20, 80]) {
		test(`keeps lines within width ${width}`, () => {
			const h = harness();
			createTodoWidget(h, state([task(1, "界界界 long subject", "pending")]));
			for (const line of component(h).render(width))
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		});
	}

	test("shows newly completed tasks until hideCompleted", () => {
		const h = harness();
		const widget = createTodoWidget(
			h,
			state([task(1, "working", "in_progress"), task(2, "next", "pending")]),
		)!;
		const view = component(h);
		widget.refresh(state([task(1, "working", "completed"), task(2, "next", "in_progress")]));
		const visible = view.render(80).join("\n");
		expect(visible).toContain("Todos (1/2)");
		expect(visible).toContain("✓ #1 ~working~");
		expect(visible).toContain("◐ #2 next");
		widget.hideCompleted();
		const hidden = view.render(80).join("\n");
		expect(hidden).toContain("Todos (0/1)");
		expect(hidden).not.toContain("working");
		expect(h.tuiRenders()).toBe(2);
	});

	test("briefly shows all-completed state, then unregisters", () => {
		const h = harness();
		const widget = createTodoWidget(h, state([task(1, "done", "in_progress")]))!;
		const view = component(h);
		widget.refresh(state([task(1, "done", "completed")]));
		expect(view.render(80)).toEqual(["✓ Todos (1/1)", "└─ ✓ #1 ~done~", ""]);
		widget.hideCompleted();
		expect(h.calls.at(-1)?.content).toBeUndefined();
		const callCount = h.calls.length;
		widget.refresh(state([task(1, "done", "completed")]), false);
		expect(h.calls).toHaveLength(callCount);
	});

	test("does not surface completed transitions when tracking is disabled", () => {
		const h = harness();
		const widget = createTodoWidget(h, state([task(1, "work", "in_progress")]))!;
		widget.refresh(state([task(1, "work", "completed")]), false);
		expect(h.calls.at(-1)?.content).toBeUndefined();
	});

	test("dims temporary blocked work and hides it on request", () => {
		const h = harness();
		const theme = recordingTheme();
		const widget = createTodoWidget(h, state([task(1, "blocked", "blocked")]))!;
		const lines = component(h, theme).render(80);
		expect(lines[0]).toBe("<dim>⊘</dim> <text>Todos (0/1)</text>");
		expect(lines[1]).toContain("<dim>⊘</dim>");
		expect(lines[1]).toContain("<dim>~blocked~</dim>");
		widget.hideBlocked([1]);
		expect(h.calls.at(-1)?.content).toBeUndefined();
	});

	test("hide only unregisters rendering and refresh shows active state again", () => {
		const h = harness();
		const widget = createTodoWidget(h, state([task(1, "work", "pending")]))!;
		widget.hide();
		expect(h.calls.at(-1)?.content).toBeUndefined();
		widget.refresh(state([task(1, "work", "pending")]));
		expect(typeof h.calls.at(-1)?.content).toBe("function");
	});

	test("disposal is idempotent", () => {
		const h = harness();
		const widget = createTodoWidget(h, state([task(1, "x", "pending")]))!;
		widget.dispose();
		widget.dispose();
		expect(h.calls.filter((call) => call.content === undefined)).toHaveLength(1);
	});
});
