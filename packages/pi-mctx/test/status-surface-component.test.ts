import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MctxStatusResult } from "../src/feature.js";
import {
	createMctxStatusComponent,
	type MctxStatusTheme,
	renderMctxStatusLines,
} from "../src/status-surface.js";

const theme: MctxStatusTheme = { fg: (_role, text) => text, bold: (text) => text };
const active: MctxStatusResult = {
	kind: "active",
	projectIdentity: "project",
	sessionId: "session",
	partitionRevision: 1,
	compartments: { total: 1, m0: 1, m1: 0 },
	tags: { total: 1, active: 1, pending: 0, dropped: 0 },
	historian: { kind: "active", phase: "idle", model: "provider/model" },
	trigger: { protectedTags: 1 },
};
const failed: MctxStatusResult = { kind: "failed", reason: "read failed" };
const context = { ui: { theme } } as ExtensionContext;

for (const { label, input } of [
	{ label: "escape", input: "\u001b" },
	{ label: "enter", input: "\r" },
	{ label: "ctrl+c", input: "\u0003" },
] as const) {
	test(`status ${label} closes exactly once`, (): void => {
		let closes = 0;
		const component = createMctxStatusComponent({
			feature: { status: () => active },
			context,
			host: {
				theme,
				requestRender: () => undefined,
				close: () => {
					closes++;
				},
			},
		});
		component.handleInput(input);
		component.handleInput(input);
		expect(closes).toBe(1);
		component.dispose();
	});
}

test("refresh requests render and dispose stops refresh", (): void => {
	let refresh: (() => void) | undefined;
	let renders = 0;
	const component = createMctxStatusComponent({
		feature: { status: () => active },
		context,
		host: {
			theme,
			requestRender: () => {
				renders++;
			},
			close: () => undefined,
		},
		startTimer: (callback, _delay) => {
			refresh = callback;
			return () => undefined;
		},
	});
	refresh?.();
	expect(renders).toBe(1);
	component.dispose();
	refresh?.();
	expect(renders).toBe(1);
});

test("active and failed snapshots use their available upstream content", (): void => {
	const activeRows = renderMctxStatusLines(active, 48, theme);
	const failedRows = renderMctxStatusLines(failed, 48, theme);
	expect(activeRows.length).toBe(17);
	expect(failedRows.length).toBe(6);
	expect(failedRows.length).not.toBe(activeRows.length);
});

test("theme invalidation uses the current Pi theme and requests render", (): void => {
	let currentTheme: MctxStatusTheme = theme;
	let renders = 0;
	const dynamicContext = {
		ui: {
			get theme(): MctxStatusTheme {
				return currentTheme;
			},
		},
	} as ExtensionContext;
	const component = createMctxStatusComponent({
		feature: { status: () => active },
		context: dynamicContext,
		host: {
			theme,
			requestRender: () => {
				renders++;
			},
			close: () => undefined,
		},
		startTimer: () => () => undefined,
	});
	currentTheme = {
		fg: (role, text): string => `[new:${role}]${text}`,
		bold: (text: string): string => text,
	};
	component.invalidate();
	expect(component.render(100).join("\n")).toContain("[new:accent]⚡ Magic Context Status");
	expect(renders).toBe(1);
	component.dispose();
});
