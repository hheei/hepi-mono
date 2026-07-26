import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createShellComponent } from "../../../src/core/ui/shell/component.js";
import { fakeTheme } from "../../helpers.js";

function child(label: string) {
	let input = "";
	return {
		render: () => [label],
		handleInput: (value: string) => {
			input = value;
		},
		get input() {
			return input;
		},
	};
}

describe("shared shell", () => {
	test("routes arrows, owns escape, and retains child state", () => {
		const settings = child("settings");
		const loadout = child("loadout");
		const host = {
			renders: 0,
			requestRender() {
				this.renders++;
			},
		};
		let closes = 0;
		const shell = createShellComponent({
			children: [settings, loadout],
			host,
			theme: fakeTheme() as unknown as Theme,
			close: () => {
				closes++;
			},
		});
		expect(shell.render(50).at(-1)).toBe("settings");
		shell.handleInput?.("x");
		shell.handleInput?.("\x1b[C");
		expect(shell.render(50).at(-1)).toBe("loadout");
		shell.handleInput?.("y");
		shell.handleInput?.("\x1b[D");
		expect(shell.render(50).at(-1)).toBe("settings");
		expect(settings.input).toBe("x");
		expect(loadout.input).toBe("y");
		shell.handleInput?.("\x1b");
		shell.handleInput?.("\x1b");
		expect(closes).toBe(1);
	});

	test("keeps tab outlines stateful and the Header rail on the border role", () => {
		const calls: Array<{ readonly color: string; readonly text: string }> = [];
		const theme = {
			...fakeTheme(),
			fg: (color: string, text: string) => {
				calls.push({ color, text });
				return text;
			},
		};
		const shell = createShellComponent({
			children: [child("settings"), child("loadout")],
			host: { requestRender() {} },
			theme: theme as unknown as Theme,
			close() {},
		});
		const assertRoles = (activeLabel: string, inactiveLabel: string): void => {
			expect(calls.find((call) => call.text.includes(activeLabel))?.color).toBe("accent");
			expect(calls.find((call) => call.text.includes(inactiveLabel))?.color).toBe("text");
			expect(calls.filter((call) => call.text.startsWith("╭")).map((call) => call.color)).toEqual(
				activeLabel === "Settings" ? ["accent", "text"] : ["text", "accent"],
			);
			expect(calls.find((call) => call.text.startsWith("╯"))?.color).toBe("accent");
			expect(calls.find((call) => call.text.startsWith("┴"))?.color).toBe("border");
		};
		shell.render(50);
		assertRoles("Settings", "Loadout");
		calls.length = 0;
		shell.handleInput?.("\x1b[C");
		shell.render(50);
		assertRoles("Loadout", "Settings");
	});

	test("honors initial loadout tab", () => {
		const shell = createShellComponent({
			children: [child("settings"), child("loadout")],
			initialTab: 1,
			host: { requestRender() {} },
			theme: fakeTheme() as unknown as Theme,
			close() {},
		});
		expect(shell.render(50).at(-1)).toBe("loadout");
	});
});
