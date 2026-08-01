import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyAndEmitLoaded,
	applySettings,
	createSubagentsSettingsProvider,
	loadSettings,
	persistToastFor,
	type SettingsAppliers,
	saveAndEmitChanged,
	saveSettings,
} from "../src/settings.js";

describe("pi-subagents settings provider", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	async function fixture(): Promise<{
		directory: string;
		path: string;
		context: { sessionId: string; cwd: string };
	}> {
		const directory = await mkdtemp(join(tmpdir(), "pi-subagents-settings-"));
		directories.push(directory);
		return {
			directory,
			path: join(directory, "settings.json"),
			context: { sessionId: "session-1", cwd: directory },
		};
	}

	it("registers a core-backed provider with the fixed grace field", () => {
		const provider = createSubagentsSettingsProvider();
		const runtime = provider.groups[0]?.fields;
		expect(provider.id).toBe("pi-subagents");
		expect(runtime?.find((field) => field.id === "graceTurns")?.defaultValue).toBe(5);
		expect(runtime?.find((field) => field.id === "maxConcurrent")?.defaultValue).toBe(2);
	});

	it("round-trips values through the core JSON section storage", async () => {
		const { path, context } = await fixture();
		const settings = {
			maxConcurrent: 7,
			defaultMaxTurns: 30,
			graceTurns: 5,
			defaultJoinMode: "group" as const,
			schedulingEnabled: false,
			widgetMode: "off" as const,
		};

		expect(await saveSettings(settings, context, { path })).toBe(true);
		expect(await loadSettings(context, { path })).toEqual(settings);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			"pi-subagents": { runtime: settings },
		});
	});

	it("drops invalid values and preserves the sibling settings sections", async () => {
		const { path, context } = await fixture();
		await writeFile(
			path,
			JSON.stringify({
				other: { enabled: true },
				"pi-subagents": {
					runtime: {
						maxConcurrent: 0,
						defaultMaxTurns: 0,
						graceTurns: 10,
						widgetMode: "sideways",
						outputTranscript: false,
					},
				},
			}),
		);

		expect(await loadSettings(context, { path })).toEqual({ outputTranscript: false });
		expect(await saveSettings({ maxConcurrent: 3 }, context, { path })).toBe(true);
		expect(JSON.parse(await readFile(path, "utf8")).other).toEqual({ enabled: true });
	});

	it("applies loaded values and emits lifecycle events", async () => {
		const { path, context } = await fixture();
		await saveSettings({ maxConcurrent: 3, defaultJoinMode: "async" }, context, { path });
		const applied: string[] = [];
		const appliers: SettingsAppliers = {
			setMaxConcurrent: (value) => applied.push(`max:${value}`),
			setDefaultMaxTurns: () => undefined,
			setGraceTurns: () => undefined,
			setDefaultJoinMode: (value) => applied.push(`join:${value}`),
			setSchedulingEnabled: () => undefined,
			setScopeModels: () => undefined,
			setDisableDefaultAgents: () => undefined,
			setToolDescriptionMode: () => undefined,
			setFleetView: () => undefined,
			setWidgetMode: () => undefined,
			setOutputTranscript: () => undefined,
		};
		const events: string[] = [];

		await applyAndEmitLoaded(appliers, (event) => events.push(event), context, { path });

		expect(applied).toEqual(["max:3", "join:async"]);
		expect(events).toEqual(["subagents:settings_loaded"]);
	});

	it("emits the persistence result and uses a warning on write failure", async () => {
		const { context } = await fixture();
		const events: Array<{ event: string; payload: unknown }> = [];
		const result = await saveAndEmitChanged(
			{ maxConcurrent: 2 },
			"Saved",
			(event, payload) => events.push({ event, payload }),
			context,
			{ path: join(context.cwd, "missing", "settings.json") },
		);

		expect(result.level).toBe("info");
		expect(events[0]?.event).toBe("subagents:settings_changed");
		expect(persistToastFor("Saved", false)).toEqual({
			message: "Saved (session only; failed to persist)",
			level: "warning",
		});
	});

	it("applies only the values present in a settings snapshot", () => {
		const values: string[] = [];
		applySettings(
			{ defaultMaxTurns: 40 },
			{
				setMaxConcurrent: () => values.push("max"),
				setDefaultMaxTurns: (value) => values.push(`turns:${value}`),
				setGraceTurns: () => values.push("grace"),
				setDefaultJoinMode: () => values.push("join"),
				setSchedulingEnabled: () => values.push("schedule"),
				setScopeModels: () => values.push("scope"),
				setDisableDefaultAgents: () => values.push("defaults"),
				setToolDescriptionMode: () => values.push("description"),
				setFleetView: () => values.push("fleet"),
				setWidgetMode: () => values.push("widget"),
				setOutputTranscript: () => values.push("transcript"),
			},
		);
		expect(values).toEqual(["turns:40"]);
	});
});
