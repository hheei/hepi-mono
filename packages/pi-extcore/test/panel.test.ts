import { describe, expect, it } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createSettingsPanelComponent } from "../src/settings/panel.js";
import type { SettingChange, SettingGroup } from "../src/settings/types.js";

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

const groups: SettingGroup[] = [
	{
		id: "general",
		title: "General",
		display: "plain",
		fields: [
			{ id: "first", label: "First", defaultValue: false },
			{ id: "second", label: "Second", defaultValue: false },
		],
	},
];

initTheme("dark");

describe("settings panel", () => {
	it("switches panes with Tab", () => {
		const component = createSettingsPanelComponent({ requestRender: () => {} }, theme, {
			title: "Settings",
			panes: [createPlainPane("first", "First"), createPlainPane("second", "Second")],
			onClose: () => {},
		});

		expect(renderText(component)).toContain("First");
		expect(renderText(component)).not.toContain("Second");

		component.handleInput?.("\t");

		expect(renderText(component)).toContain("Second");
		expect(renderText(component)).not.toContain("First");
	});

	it("toggles grouped settings without changing values", () => {
		const component = createSettingsPanelComponent({ requestRender: () => {} }, theme, {
			title: "Settings",
			panes: [
				{
					id: "grouped",
					title: "Grouped",
					groups: [
						{
							id: "general",
							title: "General",
							fields: [{ id: "enabled", label: "Enabled", defaultValue: true }],
						},
					],
					state: { general: { enabled: true } },
					onChange: () => {
						throw new Error("group toggle should not save");
					},
				},
			],
			onClose: () => {},
		});

		expect(renderText(component)).toContain("Enabled");
		component.handleInput?.(" ");
		expect(renderText(component)).not.toContain("Enabled");
		component.handleInput?.(" ");
		expect(renderText(component)).toContain("Enabled");
	});

	it("renders plain groups directly and omits hidden groups", () => {
		const component = createSettingsPanelComponent({ requestRender: () => {} }, theme, {
			title: "Settings",
			panes: [
				{
					id: "display",
					title: "Display",
					groups: [
						{
							id: "plain",
							title: "Plain",
							display: "plain",
							fields: [{ id: "visible", label: "Visible", defaultValue: true }],
						},
						{
							id: "hidden",
							title: "Hidden",
							display: "hidden",
							fields: [{ id: "secret", label: "Secret", defaultValue: "value" }],
						},
					],
					state: { plain: { visible: true }, hidden: { secret: "value" } },
					onChange: () => {},
				},
			],
			onClose: () => {},
		});

		const text = renderText(component);
		expect(text).toContain("Visible");
		expect(text).not.toContain("Plain");
		expect(text).not.toContain("Secret");
		expect(text).not.toContain("Hidden");
	});

	it("closes submenu and rebuilds the settings list", () => {
		let renderCount = 0;
		const component = createSettingsPanelComponent(
			{ requestRender: () => (renderCount += 1) },
			theme,
			{
				title: "Settings",
				panes: [
					{
						id: "submenu",
						title: "Submenu",
						groups: [],
						state: {},
						extraItems: [
							{
								id: "open",
								label: "Open",
								currentValue: "open",
								submenu: (_value, close) => ({
									invalidate: () => {},
									render: () => ["submenu body"],
									handleInput: () => close("done"),
								}),
							},
						],
						onChange: () => {},
					},
				],
				onClose: () => {},
			},
		);

		component.handleInput?.("\r");
		expect(renderText(component)).toContain("submenu body");
		component.handleInput?.("x");

		expect(renderText(component)).toContain("Open");
		expect(renderText(component)).not.toContain("submenu body");
		expect(renderCount).toBeGreaterThan(0);
	});

	it("reverts optimistic state and reports async save rejection", async () => {
		const errors: unknown[] = [];
		const component = createSettingsPanelComponent({ requestRender: () => {} }, theme, {
			title: "Settings",
			panes: [
				{
					id: "reject",
					title: "Reject",
					groups,
					state: { general: { first: false, second: false } },
					onChange: async () => {
						throw new Error("save failed");
					},
				},
			],
			onError: (error) => errors.push(error),
			onClose: () => {},
		});

		component.handleInput?.(" ");
		expect(renderText(component)).toContain("true");
		await flushAsyncWork();

		expect(errors).toHaveLength(1);
		expect(renderText(component)).toContain("false");
	});

	it("uses pending pane state for consecutive edits", async () => {
		let releaseFirstSave: (() => void) | undefined;
		const changes: SettingChange[] = [];
		const component = createSettingsPanelComponent({ requestRender: () => {} }, theme, {
			title: "Settings",
			panes: [
				{
					id: "test",
					title: "Test",
					groups,
					state: { general: { first: false, second: false } },
					onChange: (change) => {
						changes.push(change);
						if (changes.length === 1) {
							return new Promise<void>((resolve) => {
								releaseFirstSave = resolve;
							});
						}
					},
				},
			],
			onClose: () => {},
		});

		component.handleInput?.(" ");
		await Promise.resolve();

		expect(changes).toHaveLength(1);
		component.handleInput?.("\x1b[B");
		component.handleInput?.(" ");

		expect(changes).toHaveLength(1);
		releaseFirstSave?.();
		await flushAsyncWork();

		expect(changes).toHaveLength(2);
		expect(changes[1]?.state).toEqual({ general: { first: true, second: true } });
	});
});

function createPlainPane(id: string, label: string) {
	return {
		id,
		title: id,
		groups: [
			{
				id: "general",
				title: "General",
				display: "plain" as const,
				fields: [{ id: "enabled", label, defaultValue: true }],
			},
		],
		state: { general: { enabled: true } },
		onChange: () => {},
	};
}

function renderText(component: Component): string {
	return component.render(80).join("\n");
}

function flushAsyncWork(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
