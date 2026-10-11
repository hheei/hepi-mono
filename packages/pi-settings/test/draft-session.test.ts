import type { SettingsProvider } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import { createSettingsDraftSession } from "../src/draft-session.js";

describe("SettingsDraftSession deep module", () => {
	test("initializes defaults and manages draft lifecycle", async () => {
		const saves: unknown[] = [];
		const changes: unknown[] = [];
		const provider: SettingsProvider = {
			id: "test",
			title: "Test",
			groups: [
				{
					id: "general",
					title: "General",
					fields: [
						{
							id: "enabled",
							label: "Enabled",
							type: "boolean",
							defaultValue: false,
							description: "Test enabled toggle",
							parse: (v) => v === "true",
						},
						{
							id: "mode",
							label: "Mode",
							type: "enum",
							defaultValue: "auto",
							description: "Test mode enum",
							options: [{ value: "auto" }, { value: "manual" }],
							parse: (v) => v,
						},
					],
				},
			],
			storage: {
				load: () => undefined,
				save: (state) => {
					saves.push(state);
				},
			},
			onChange: (change) => {
				changes.push(change);
			},
		};

		const session = await createSettingsDraftSession(provider, { sessionId: "s1" });
		expect(session.get("general", "enabled")).toBe(false);
		expect(session.isModified()).toBe(false);

		session.cycle("general", "enabled");
		expect(session.get("general", "enabled")).toBe(true);
		expect(session.isModified()).toBe(true);

		session.cycle("general", "mode");
		expect(session.get("general", "mode")).toBe("manual");

		await session.commit();
		expect(session.isModified()).toBe(false);
		expect(saves).toHaveLength(1);
		expect(saves[0]).toEqual({ general: { enabled: true, mode: "manual" } });
		expect(changes).toHaveLength(2);

		await session.close();
	});

	test("rolls back uncommitted modifications", async () => {
		const provider: SettingsProvider = {
			id: "test",
			title: "Test",
			groups: [
				{
					id: "general",
					title: "General",
					fields: [
						{
							id: "count",
							label: "Count",
							type: "number",
							defaultValue: 10,
							description: "Test count",
							parse: (v) => Number(v),
						},
					],
				},
			],
			storage: { load: () => ({ general: { count: 5 } }), save: () => undefined },
		};

		const session = await createSettingsDraftSession(provider, { sessionId: "s2" });
		expect(session.get("general", "count")).toBe(5);

		session.set("general", "count", 42);
		expect(session.get("general", "count")).toBe(42);
		expect(session.isModified()).toBe(true);

		session.rollback();
		expect(session.get("general", "count")).toBe(5);
		expect(session.isModified()).toBe(false);
	});
});
