import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { HepiSettingField, HepiSettingsProvider } from "../../../src/core/api/settings.js";
import { createHepiModelSelectionField } from "../../../src/core/index.js";
import { createSettingsComponent } from "../../../src/core/ui/settings/component.js";
import { createSettingsController } from "../../../src/core/ui/settings/controller.js";
import { fakeHost, fakeStorage, fakeTheme, stripAnsi, testContext } from "../../helpers.js";

const theme = fakeTheme() as unknown as Theme;
const toggleFooter = "↕ navigate · ↔ tab · ␣ toggle · ⎋ close";
const editNavigationFooter = "↕ navigate · ↔ tab · ␣ select · ⎋ close";
const textEditFooter = "⏎ confirm · ⎋ cancel";
const enumEditFooter = "↕ select · ⏎ done · ⎋ close";
const fields: readonly HepiSettingField[] = [
	{
		id: "enabled",
		label: "Enabled",
		type: "boolean",
		defaultValue: true,
		description: "Enable or disable the fixture feature shown by the Settings component.",
		parse: (draft) => draft === "true",
	},
	{
		id: "mode",
		label: "Mode",
		type: "enum",
		defaultValue: "auto",
		description: "Choose automatic or manual behavior for the Settings component fixture.",
		options: [{ value: "auto" }, { value: "manual" }],
		parse: (draft) => draft,
	},
	{
		id: "name",
		label: "Name",
		type: "text",
		defaultValue: "Alice",
		description: "Set the fixture display name shown by the Settings component.",
		parse: (draft) => draft,
	},
	{
		id: "strict",
		label: "Strict",
		type: "text",
		defaultValue: "ok",
		description: "Set a validated fixture value used to test visible parse errors.",
		parse: (draft) => {
			if (draft === "bad") throw new Error("invalid draft");
			return draft;
		},
	},
];

function provider(id = "first", title = "First Provider"): HepiSettingsProvider {
	return {
		id,
		title,
		groups: [{ id: "general", title: "General", fields }],
		storage: fakeStorage(),
	};
}

async function setup(
	providers: readonly HepiSettingsProvider[] = [provider()],
	height?: number,
	showTabs = true,
	componentTheme: Theme = theme,
) {
	const controller = createSettingsController({ providers, context: testContext() });
	await controller.load();
	const host = fakeHost();
	let closes = 0;
	const component = createSettingsComponent({
		controller,
		host,
		theme: componentTheme,
		...(height === undefined ? {} : { height }),
		showTabs,
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
	test("separates model list and Description value formats", async () => {
		const model = createHepiModelSelectionField({
			id: "model",
			label: "Advisor model",
			description: "Select the model used by this settings rendering fixture.",
			modelOptions: [{ value: "cx/gpt-5.6-luna", label: "cx/gpt-5.6-luna" }],
			thinking: {
				fieldId: "thinking",
				label: "Thinking",
				description: "Select the reasoning intensity used by this settings rendering fixture.",
				defaultValue: "medium",
				options: [
					{ value: "low", label: "low" },
					{ value: "medium", label: "medium" },
				],
			},
		});
		const state = await setup([
			{
				id: "model-provider",
				title: "Model Provider",
				groups: [{ id: "models", title: "", fields: [model] }],
				storage: fakeStorage({
					initial: { models: { model: "cx/gpt-5.6-luna", thinking: "low" } },
				}),
			},
		]);
		const screen = text(state.component, 100);
		expect(screen).toContain("◔ cx/gpt-5.6-luna");
		expect(screen).toContain("Value: cx/gpt-5.6-luna low");
	});

	test("renders plugin titles with the plugin glyph and indents child settings", async () => {
		const state = await setup();
		const lines = state.component.render(100).map(stripAnsi);
		const title = lines.find((line) => line.includes("General"));
		const child = lines.find((line) => line.includes("Enabled"));
		expect(title).toStartWith("⧉ General");
		expect(title).not.toContain("▾");
		expect(child?.indexOf("Enabled")).toBe(2);
	});

	test("uses the Loadout dim role for the action hint bar", async () => {
		const calls: Array<{ readonly role: string; readonly text: string }> = [];
		const recordingTheme = {
			fg: (role: string, text: string) => {
				calls.push({ role, text });
				return text;
			},
			bold: (text: string) => text,
		} as unknown as Theme;
		const state = await setup([provider()], undefined, true, recordingTheme);
		state.component.render(100);
		expect(calls).toContainEqual({ role: "dim", text: toggleFooter });
	});

	test("keeps one cell between the selection arrow and key, then scrolls overflow left to right", async () => {
		const longLabel = "A setting key that is deliberately much longer than the available column";
		const state = await setup([
			{
				...provider(),
				groups: [
					{ id: "general", title: "General", fields: [{ ...fields[0]!, label: longLabel }] },
				],
			},
		]);
		const selected = (): string =>
			state.component
				.render(48)
				.map(stripAnsi)
				.find((line) => line.startsWith("→ ")) ?? "";
		const initial = selected();
		expect(initial).toContain("→ A setting");
		await Bun.sleep(650);
		expect(state.host.renderRequests).toBe(0);
		await Bun.sleep(150);
		const advanced = selected();
		expect(advanced).not.toBe(initial);
		expect(state.host.renderRequests).toBeGreaterThan(0);
		state.component.handleInput?.("\x1b");
		const requestsAfterClose = state.host.renderRequests;
		await Bun.sleep(140);
		expect(state.host.renderRequests).toBe(requestsAfterClose);
	});

	test("does not schedule marquee redraws for a key that fits", async () => {
		const state = await setup();
		state.component.render(48);
		await Bun.sleep(800);
		expect(state.host.renderRequests).toBe(0);
	});

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
		expect(text(state.component)).toContain("> Alice!");
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

	test("cycles an empty model in edit mode without entering main-tab navigation", async () => {
		const model = createHepiModelSelectionField({
			id: "model",
			label: "Advisor model",
			description: "Select the model used by this settings rendering fixture.",
			modelOptions: [
				{ value: "", label: "Not set" },
				{ value: "provider/first", label: "provider/first" },
				{ value: "provider/second", label: "provider/second" },
			],
			thinking: {
				fieldId: "thinking",
				label: "Thinking",
				description: "Select the reasoning intensity used by this fixture.",
				defaultValue: "medium",
				options: [{ value: "medium" }],
			},
		});
		const state = await setup([
			{
				id: "advisor",
				title: "Advisor",
				groups: [{ id: "advisor", title: "", fields: [model] }],
				storage: fakeStorage({ initial: { advisor: { model: "" } } }),
			},
		]);
		state.component.handleInput?.(" ");
		expect(state.controller.state.mode).toBe("Edit");
		state.component.handleInput?.("\x1b[B");
		expect(state.controller.state.draftValue).toBe("provider/first");
		state.component.handleInput?.("\x1b[A");
		expect(state.controller.state.draftValue).toBe("");
		state.component.handleInput?.("\x1b[C");
		state.component.handleInput?.("\x1b[D");
		expect(state.controller.state.mode).toBe("Edit");
		expect(text(state.component)).not.toContain("Loadout shared tab is available.");
		expect(text(state.component)).not.toContain("█");
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

	test("cycles a related value with Tab without switching the main tab", async () => {
		const tabFields = fields.map((field) =>
			field.id === "mode"
				? {
						...field,
						tabCycle: {
							fieldId: "thinking",
							label: "Thinking",
							description: "Choose the fixture reasoning intensity paired with the selected mode.",
							defaultValue: "medium",
							options: [{ value: "medium" }, { value: "high" }],
						},
					}
				: field,
		);
		const tabProvider = {
			...provider(),
			groups: [{ id: "general", title: "General", fields: tabFields }],
		};
		const state = await setup([tabProvider]);
		state.controller.select("mode");
		state.component.handleInput?.("\t");
		expect(state.controller.state.committed.first?.general?.thinking).toBe("medium");
		expect(text(state.component)).toContain("auto · high");
		expect(text(state.component, 100)).toContain("Value: auto · high");
		expect(text(state.component, 100)).not.toContain("Value: auto█ · high");
		expect(text(state.component)).not.toContain("Loadout shared tab is available.");
		state.component.handleInput?.("\r");
		await flush();
		expect(state.controller.state.committed.first?.general?.thinking).toBe("high");
	});

	test("defers tab-cycle validation until Enter", async () => {
		const tabFields = fields.map((field) =>
			field.id === "mode"
				? {
						...field,
						tabCycle: {
							fieldId: "thinking",
							label: "Thinking",
							description: "Choose the fixture reasoning intensity paired with the selected mode.",
							defaultValue: "medium",
							options: [{ value: "medium" }, { value: "high" }],
						},
					}
				: field,
		);
		const baseProvider = provider();
		const invalidProvider: HepiSettingsProvider = {
			...baseProvider,
			groups: [{ id: "general", title: "General", fields: tabFields }],
			storage: {
				...baseProvider.storage,
				validate: (state) => {
					if (state.general?.mode === "manual" && state.general.thinking === "high")
						throw new Error("thinking level unsupported");
				},
			},
		};
		const state = await setup([invalidProvider]);
		state.controller.select("mode");
		state.component.handleInput?.("\r");
		state.component.handleInput?.("\x1b[B");
		state.component.handleInput?.("\t");
		await flush();
		expect(state.controller.state.committed.first?.general?.mode).toBe("auto");
		expect(state.controller.state.committed.first?.general?.thinking).toBe("medium");
		state.component.handleInput?.("\r");
		await flush();
		expect(state.controller.state.mode).toBe("Edit");
		expect(text(state.component)).toContain("thinking level unsupported");
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
		expect(state.controller.state.selection?.itemId).toBe("enabled");
		state.component.handleInput?.(" ");
		expect(text(state.component)).toContain("Enabled");
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

	test("switches main tabs with arrows while editing an empty text value", async () => {
		const emptyField: HepiSettingField = {
			id: "empty",
			label: "Empty",
			type: "text",
			defaultValue: "",
			description: "Edit an empty fixture value before switching between main tabs.",
			parse: (draft) => draft,
		};
		const state = await setup([
			{
				...provider(),
				groups: [{ id: "general", title: "General", fields: [emptyField] }],
			},
		]);
		state.component.handleInput?.(" ");
		expect(state.controller.state.mode).toBe("Edit");
		state.component.handleInput?.("\x1b[C");
		expect(text(state.component)).toContain("Loadout shared tab is available.");
		state.component.handleInput?.("\x1b[D");
		expect(text(state.component)).toContain("Empty");

		const singlePage = await setup(
			[
				{
					...provider(),
					groups: [{ id: "general", title: "General", fields: [emptyField] }],
				},
			],
			undefined,
			false,
		);
		singlePage.component.handleInput?.(" ");
		singlePage.component.handleInput?.("\x1b[C");
		expect(singlePage.controller.state.mode).toBe("Edit");
		expect(text(singlePage.component)).toContain("Empty");
		expect(text(singlePage.component)).not.toContain("Loadout shared tab is available.");
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
		expect(text(state.component)).toContain("> bad");
		state.component.handleInput?.("\x1b");
		expect(state.controller.state.mode).toBe("Navigation");
		expect(state.controller.state.committed.first!.general!.strict).toBe("ok");
	});

	test("commits the draft in memory and defers persistence until close", async () => {
		const failing = { ...provider(), storage: fakeStorage({ failSave: new Error("save failed") }) };
		const state = await setup([failing]);
		state.controller.select("name");
		state.component.handleInput?.(" ");
		state.component.handleInput?.("!");
		state.component.handleInput?.("\r");
		await flush();
		expect(state.controller.state.mode).toBe("Navigation");
		expect(state.controller.state.committed.first!.general!.name).toBe("Alice!");
		expect(state.controller.state.selection?.itemId).toBe("name");
		await expect(state.controller.close()).rejects.toThrow("Settings cleanup failed");
		expect(text(state.component)).toContain("Error: save failed");
	});
	test("keeps the last provider visible while scrolling at terminal-relative height", async () => {
		const providers = Array.from({ length: 15 }, (_, index) => ({
			...provider(`provider-${index}`, `Provider ${index}`),
			groups: [
				{
					id: `group-${index}`,
					title: index === 14 ? "Traditional to Simplified" : `Provider ${index}`,
					fields: [{ ...fields[0]!, id: `enabled-${index}` }],
				},
			],
		}));
		const combined = {
			...provider("combined", "Combined"),
			groups: providers.flatMap((item) => item.groups),
		};
		const { component, controller } = await setup([combined], 50);
		component.render(100);
		for (let index = 0; index < 6; index++) {
			component.handleInput?.("\x1b[B");
			component.render(100);
		}
		expect(controller.state.selection).toMatchObject({
			itemId: "enabled-6",
			groupId: "group-6",
		});
		expect(controller.state.scrollTop).toBe(7);
		for (let index = 6; index < 29; index++) {
			component.handleInput?.("\x1b[B");
			component.render(100);
		}
		const screen = component.render(100).map(stripAnsi).join("\n");
		expect(screen).toContain("Traditional to Simplif");
		expect(controller.state.selection).toMatchObject({
			itemId: "enabled-14",
			groupId: "group-14",
		});
		expect(controller.state.scrollTop).toBe(17);
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
