import { describe, expect, test } from "bun:test";
import type { ExtensionPageViewContext, HepiSettingsProvider } from "@hheei/pi-ext-core";
import { replayTui, viewFrame } from "../../hepi-debug/src/tui-replay.js";
import { createSettingsPage } from "../src/settings-page.js";

function context(): {
	readonly value: ExtensionPageViewContext;
	readonly closes: { value: number };
} {
	const closes = { value: 0 };
	return {
		value: {
			command: {
				cwd: "/workspace",
				sessionManager: { getSessionId: () => "settings-test-session" },
				ui: { notify: () => undefined },
			} as never,
			signal: new AbortController().signal,
			theme: { fg: (_role: string, value: string) => value, bold: (value: string) => value },
			requestRender: () => undefined,
			requestClose: () => closes.value++,
		},
		closes,
	};
}

describe("Settings provider page", () => {
	test("loads a provider draft, saves on close, and delegates live change ownership", async () => {
		const saved: unknown[] = [];
		const changes: unknown[] = [];
		const sessionIds: string[] = [];
		const provider: HepiSettingsProvider = {
			id: "example",
			title: "Example",
			groups: [
				{
					id: "display",
					title: "Display",
					fields: [
						{
							id: "enabled",
							label: "Enabled",
							type: "boolean",
							defaultValue: true,
							description: "Controls whether the example extension is active for this session.",
							parse: (value) => value === "true",
						},
					],
				},
			],
			storage: {
				load: (context) => {
					sessionIds.push(context.sessionId);
					return { display: { enabled: true } };
				},
				save: (state) => saved.push(state),
			},
			onChange: (change) => changes.push(change),
		};
		const h = context();
		const page = await createSettingsPage({ list: () => [provider] } as never, h.value);
		expect(page.component.render(100).join("\n")).toContain("Controls whether the example");
		expect(await page.handleInput(" ")).toBe(true);
		expect(await page.handleInput("\u001b")).toBe(true);
		expect(changes).toHaveLength(1);
		expect(saved).toEqual([{ display: { enabled: false } }]);
		expect(sessionIds).toEqual(["settings-test-session"]);
		expect(h.closes.value).toBe(1);
	});

	test("renders the combined group tree and flushes before handing arrows to the router", async () => {
		const saves: unknown[] = [];
		const providers: HepiSettingsProvider[] = ["Alpha", "Beta"].map((title) => ({
			id: title.toLocaleLowerCase(),
			title,
			groups: [
				{
					id: "general",
					title: "General",
					fields: [
						{
							id: "mode",
							label: "Mode",
							type: "enum",
							defaultValue: "auto",
							description: "Chooses the operating mode for this grouped settings fixture.",
							options: [{ value: "auto" }, { value: "manual" }],
							parse: (value) => value,
						},
					],
				},
			],
			storage: { load: () => undefined, save: (state) => saves.push({ title, state }) },
		}));
		const h = context();
		const page = await createSettingsPage({ list: () => providers } as never, h.value);
		const rendered = page.component.render(100).join("\n");
		expect(rendered).toContain("⧉ pi-alpha");
		expect(rendered).toContain("⧉ pi-beta");
		expect(rendered).toContain("Origin: @hheei/pi-settings");

		expect(await page.handleInput(" ")).toBe(true);
		expect(await page.handleInput("\u001b[B")).toBe(true);
		expect(await page.handleInput("\r")).toBe(true);
		expect(await page.handleInput("\u001b[C")).toBe(false);
		expect(saves).toHaveLength(2);
		expect((saves[0] as { state: { general: { mode: string } } }).state.general.mode).toBe(
			"manual",
		);
	});

	test("keeps a failed save draft visible and consumes router navigation", async () => {
		const provider: HepiSettingsProvider = {
			id: "failure",
			title: "Failure",
			groups: [
				{
					id: "general",
					title: "General",
					fields: [
						{
							id: "enabled",
							label: "Enabled",
							type: "boolean",
							defaultValue: true,
							description: "Controls the failing save fixture used to retain an editable draft.",
							parse: (value) => value === "true",
						},
					],
				},
			],
			storage: {
				load: () => undefined,
				save: () => {
					throw new Error("disk full");
				},
			},
		};
		const h = context();
		const page = await createSettingsPage({ list: () => [provider] } as never, h.value);
		await page.handleInput(" ");
		expect(await page.handleInput("\u001b[C")).toBe(true);
		const rendered = page.component.render(100).join("\n");
		expect(rendered).toContain("Value: false");
		expect(rendered).toContain("Error: disk full");
		expect(h.closes.value).toBe(0);
	});

	test("keeps a fixed panel, separate scrollbar, and centered selected row", async () => {
		const fields = Array.from({ length: 20 }, (_, index) => ({
			id: `field-${index}`,
			label: `Field ${index}`,
			type: "boolean" as const,
			defaultValue: true,
			description: `Controls fixture field ${index} for the Settings viewport regression test.`,
			parse: (value: string) => value === "true",
		}));
		const provider: HepiSettingsProvider = {
			id: "many",
			title: "Many",
			groups: [{ id: "general", title: "General", fields }],
			storage: { load: () => undefined, save: () => undefined },
		};
		const h = context();
		const page = await createSettingsPage({ list: () => [provider] } as never, h.value);
		const initial = page.component.render(100);
		expect(initial).toHaveLength(20);
		expect(initial[19]).toContain("↕ navigate");
		expect(initial.some((line) => line[56] === "█" || line[56] === "│")).toBe(true);
		for (let index = 0; index < 12; index++) await page.handleInput("\u001b[B");
		expect(page.component.render(100)[10]).toContain("→ Field 12");
		const replay = await replayTui({
			columns: 100,
			rows: 20,
			create: () => page.component,
			actions: [],
		});
		expect(viewFrame(replay.last)).toHaveLength(20);
		expect(viewFrame(replay.last)[19]).toContain("↕ navigate");
		expect(page.component.render(60).join("\n")).toContain("Origin: @hheei/pi-settings");
	});

	test("cycles a related tab value inside the legacy enum editor", async () => {
		const saved: unknown[] = [];
		const provider: HepiSettingsProvider = {
			id: "cycle",
			title: "Cycle",
			groups: [
				{
					id: "general",
					title: "General",
					fields: [
						{
							id: "mode",
							label: "Mode",
							type: "enum",
							defaultValue: "auto",
							description: "Chooses a fixture mode with a related reasoning setting.",
							options: [{ value: "auto" }, { value: "manual" }],
							tabCycle: {
								fieldId: "thinking",
								label: "Thinking",
								description: "Chooses reasoning intensity related to the selected fixture mode.",
								defaultValue: "low",
								options: [{ value: "low" }, { value: "high" }],
							},
							parse: (value) => value,
						},
					],
				},
			],
			storage: { load: () => undefined, save: (state) => saved.push(state) },
		};
		const page = await createSettingsPage({ list: () => [provider] } as never, context().value);
		await page.handleInput(" ");
		await page.handleInput("\t");
		await page.handleInput("\r");
		expect(await page.handleInput("\u001b[C")).toBe(false);
		expect(saved).toEqual([{ general: { mode: "auto", thinking: "high" } }]);
	});

	test("marquees only an overflowing selected label and clears it on disposal", async () => {
		const provider: HepiSettingsProvider = {
			id: "marquee",
			title: "Marquee",
			groups: [
				{
					id: "general",
					title: "General",
					fields: [
						{
							id: "long",
							label: "A deliberately long Settings label that needs the legacy horizontal marquee",
							type: "boolean",
							defaultValue: true,
							description:
								"Controls the long label marquee fixture for the Settings page renderer.",
							parse: (value) => value === "true",
						},
					],
				},
			],
			storage: { load: () => undefined, save: () => undefined },
		};
		const page = await createSettingsPage({ list: () => [provider] } as never, context().value);
		const initial = page.component.render(48).join("\n");
		await Bun.sleep(800);
		const advanced = page.component.render(48).join("\n");
		expect(advanced).not.toBe(initial);
		await page.close();
	});
});
