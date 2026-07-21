import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { HePiSettingField, HePiSettingsProvider } from "../../../src/api/settings.js";
import { createSettingsComponent } from "../../../src/modules/setting/component.js";
import { createSettingsController } from "../../../src/modules/setting/controller.js";
import { fakeHost, fakeStorage, fakeTheme, stripAnsi, testContext } from "../../helpers.js";

const theme = fakeTheme() as unknown as Theme;
const toggleFooter = "↕ navigate · ↔ tab · ␣ toggle · ⎋ close";
const editNavigationFooter = "↕ navigate · ↔ tab · ␣ select · ⎋ close";
const textEditFooter = "⏎ confirm · ⎋ cancel";
const enumEditFooter = "↕ select · ⏎ done · ⎋ close";
const fields: readonly HePiSettingField[] = [
	{
		id: "enabled",
		label: "Enabled",
		type: "boolean",
		defaultValue: true,
		parse: (draft) => draft === "true",
	},
	{
		id: "mode",
		label: "Mode",
		type: "enum",
		defaultValue: "auto",
		options: [{ value: "auto" }, { value: "manual" }],
		parse: (draft) => draft,
	},
	{ id: "name", label: "Name", type: "text", defaultValue: "Alice", parse: (draft) => draft },
	{
		id: "strict",
		label: "Strict",
		type: "text",
		defaultValue: "ok",
		parse: (draft) => {
			if (draft === "bad") throw new Error("invalid draft");
			return draft;
		},
	},
];

function provider(id = "first", title = "First Provider"): HePiSettingsProvider {
	return {
		id,
		title,
		groups: [{ id: "general", title: "General", fields }],
		storage: fakeStorage(),
	};
}

async function setup(providers: readonly HePiSettingsProvider[] = [provider()]) {
	const controller = createSettingsController({ providers, context: testContext() });
	await controller.load();
	const host = fakeHost();
	let closes = 0;
	const component = createSettingsComponent({
		controller,
		host,
		theme,
		close: () => {
			closes++;
		},
	});
	return {
		controller,
		host,
		component,
		get closes() {
			return closes;
		},
	};
}

async function flush(): Promise<void> {
	await Bun.sleep(0);
	await Promise.resolve();
}

function text(component: { render(width: number): string[] }, width = 48): string {
	return component.render(width).map(stripAnsi).join("\n");
}

describe("settings component", () => {
	test("matches footer through toggle, edit, cancel, confirm, and close", async () => {
		const state = await setup();
		expect(text(state.component, 100).split("\n").at(-2)).toBe(toggleFooter);
		state.component.handleInput?.("\r");
		expect(state.controller.state.committed.first!.general!.enabled).toBe(true);
		state.component.handleInput?.(" ");
		expect(state.controller.state.committed.first!.general!.enabled).toBe(false);
		expect(state.controller.state.mode).toBe("Navigation");
		expect(text(state.component, 100).split("\n").at(-2)).toBe(toggleFooter);
		await flush();

		state.component.handleInput?.("\x1b[B");
		expect(state.controller.state.selection?.itemId).toBe("mode");
		state.component.handleInput?.(" ");
		expect(state.controller.state.mode).toBe("Edit");
		expect(state.controller.state.draftValue).toBe("auto");
		expect(state.controller.state.committed.first!.general!.mode).toBe("auto");
		expect(text(state.component, 100).split("\n").at(-2)).toBe(enumEditFooter);
		state.component.handleInput?.("\x1b");
		expect(state.controller.state.mode).toBe("Navigation");
		expect(state.controller.state.committed.first!.general!.mode).toBe("auto");
		expect(text(state.component, 100).split("\n").at(-2)).toBe(editNavigationFooter);

		state.component.handleInput?.("\x1b[B");
		state.component.handleInput?.(" ");
		expect(state.controller.state.mode).toBe("Edit");
		expect(text(state.component, 100).split("\n").at(-2)).toBe(textEditFooter);
		state.component.handleInput?.("!");
		expect(text(state.component)).toContain("Alice");
		expect(text(state.component)).toContain("> Alice!█");
		state.component.handleInput?.("\x1b");
		expect(state.controller.state.mode).toBe("Navigation");
		expect(state.controller.state.committed.first!.general!.name).toBe("Alice");
		expect(text(state.component, 100).split("\n").at(-2)).toBe(
			"↕ navigate · ↔ tab · ␣ edit · ⎋ close",
		);

		state.component.handleInput?.(" ");
		state.component.handleInput?.("!");
		state.component.handleInput?.("\r");
		await flush();
		expect(state.controller.state.mode).toBe("Navigation");
		expect(state.controller.state.committed.first!.general!.name).toBe("Alice!");
		expect(state.controller.state.selection?.itemId).toBe("name");
		expect(text(state.component, 100).split("\n").at(-2)).toBe(
			"↕ navigate · ↔ tab · ␣ edit · ⎋ close",
		);
		state.component.invalidate();
		state.component.handleInput?.("\x1b");
		expect(state.closes).toBe(1);
	});

	test("cycles enum settings with arrows after entering selection", async () => {
		const state = await setup();
		state.component.handleInput?.("\x1b[B");
		state.component.handleInput?.("\r");
		expect(state.controller.state.mode).toBe("Edit");
		state.component.handleInput?.("\x1b[B");
		await flush();
		expect(state.controller.state.committed.first!.general!.mode).toBe("manual");
		expect(state.controller.state.mode).toBe("Edit");
		state.component.handleInput?.("\r");
		expect(state.controller.state.mode).toBe("Navigation");
	});

	test("ignores printable input while editing enum settings", async () => {
		const state = await setup();
		state.component.handleInput?.("\x1b[B");
		state.component.handleInput?.("\r");
		state.component.handleInput?.("x");
		expect(state.controller.state.mode).toBe("Edit");
		expect(state.controller.state.draftValue).toBe("auto");
		state.component.handleInput?.("\r");
	});

	test("switches main tabs with arrows and keeps Settings content usable", async () => {
		const state = await setup();
		expect(text(state.component)).toContain("⚙ Settings");
		expect(text(state.component)).toContain("◈ Loadout");
		state.component.handleInput?.("\x1b[C");
		expect(text(state.component)).toContain("Loadout shared tab is available.");
		expect(text(state.component, 100).split("\n").at(-2)).toBe(toggleFooter);
		state.component.handleInput?.("\x1b[D");
		expect(text(state.component)).toContain("Enabled");
		expect(text(state.component, 100).split("\n").at(-2)).toBe(toggleFooter);

		state.component.handleInput?.("\x1b[A");
		expect(state.controller.state.selection?.itemId).toBe("group:general");
		state.component.handleInput?.(" ");
		expect(text(state.component)).not.toContain("Enabled");
		for (const character of "Enabled") state.component.handleInput?.(character);
		expect(state.controller.state.search).toBe("Enabled");
		expect(state.controller.state.selection?.itemId).toBe("enabled");
		expect(text(state.component)).toContain("Enabled");
		state.component.handleInput?.("\x7f");
		expect(state.controller.state.search).toBe("Enable");
		expect(text(state.component)).toContain("> Enable");
		expect(
			text(state.component)
				.split("\n")
				.some((line) => line.trim() === "_"),
		).toBe(false);
	});

	test("retains committed value, draft, selection, and visible parse error", async () => {
		const state = await setup();
		state.controller.select("strict");
		state.component.handleInput?.(" ");
		state.component.handleInput?.("\x1b[H");
		state.component.handleInput?.("\x1b[3~");
		state.component.handleInput?.("\x1b[3~");
		for (const character of "bad") state.component.handleInput?.(character);
		state.component.handleInput?.("\r");
		await flush();
		expect(state.controller.state.mode).toBe("Edit");
		expect(state.controller.state.draftValue).toBe("bad");
		expect(state.controller.state.committed.first!.general!.strict).toBe("ok");
		expect(state.controller.state.selection?.itemId).toBe("strict");
		expect(text(state.component)).toContain("Error: invalid draft");
		expect(text(state.component)).toContain("> bad█");
		state.component.handleInput?.("\x1b");
		expect(state.controller.state.mode).toBe("Navigation");
		expect(state.controller.state.committed.first!.general!.strict).toBe("ok");
	});

	test("keeps draft and rolls back committed value after rejected save", async () => {
		const failing = { ...provider(), storage: fakeStorage({ failSave: new Error("save failed") }) };
		const state = await setup([failing]);
		state.controller.select("name");
		state.component.handleInput?.(" ");
		state.component.handleInput?.("!");
		state.component.handleInput?.("\r");
		await flush();
		expect(state.controller.state.mode).toBe("Edit");
		expect(state.controller.state.draftValue).toBe("Alice!");
		expect(state.controller.state.committed.first!.general!.name).toBe("Alice");
		expect(state.controller.state.selection?.itemId).toBe("name");
		expect(text(state.component)).toContain("Error: save failed");
		expect(text(state.component)).toContain("> Alice!█");
	});
	test("renders and routes input to panels-only provider", async () => {
		const inputs: string[] = [];
		let invalidations = 0;
		const panel = {
			id: "panel",
			label: "Panel",
			render: (width: number) => [`Panel output ${width}`],
			handleInput: (input: string) => {
				inputs.push(input);
				return true;
			},
			invalidate: () => {
				invalidations++;
			},
		};
		const state = await setup([{ ...provider("panel-provider"), groups: [], panels: [panel] }]);
		expect(text(state.component)).toContain("Panel output 48");
		state.component.handleInput?.("x");
		expect(inputs).toEqual(["x"]);
		state.component.invalidate();
		expect(invalidations).toBe(1);
		expect(state.host.renderRequests).toBeGreaterThan(0);
	});
});
