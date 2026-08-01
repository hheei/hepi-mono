import { describe, expect, test } from "bun:test";
import type { ExtensionPageViewContext, HepiSettingsProvider } from "@hheei/pi-ext-core";
import { createSettingsPage } from "../src/settings-page.js";

function context(): {
	readonly value: ExtensionPageViewContext;
	readonly closes: { value: number };
} {
	const closes = { value: 0 };
	return {
		value: {
			command: { cwd: "/workspace", ui: { notify: () => undefined } } as never,
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
				load: () => ({ display: { enabled: true } }),
				save: (state) => saved.push(state),
			},
			onChange: (change) => changes.push(change),
		};
		const h = context();
		const page = await createSettingsPage({ list: () => [provider] } as never, h.value);
		expect(page.component.render(100).join("\n")).toContain("Controls whether the example");
		expect(await page.handleInput(" ")).toBe(true);
		await page.close();
		expect(changes).toHaveLength(1);
		expect(saved).toEqual([{ display: { enabled: false } }]);
		expect(h.closes.value).toBe(1);
	});
});
