import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSubagentsConfiguration } from "../src/config.js";

async function withSettings<T>(
	global: unknown,
	project: unknown,
	run: (paths: { readonly globalPath: string; readonly projectPath: string }) => Promise<T>,
): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
	const paths = {
		globalPath: join(directory, "global.json"),
		projectPath: join(directory, "project.json"),
	};
	try {
		await writeFile(paths.globalPath, JSON.stringify(global), "utf8");
		await writeFile(paths.projectPath, JSON.stringify(project), "utf8");
		return await run(paths);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("uses user cap and permits a project to reduce but never raise it", async () => {
	const reduced = await withSettings(
		{ "pi-subagents": { max_active_turns: 6 } },
		{ "pi-subagents": { max_active_turns: 3 } },
		loadSubagentsConfiguration,
	);
	expect(reduced).toMatchObject({ maxActiveTurns: 3, state: { kind: "valid" } });

	const raised = await withSettings(
		{ "pi-subagents": { max_active_turns: 3 } },
		{ "pi-subagents": { max_active_turns: 6 } },
		loadSubagentsConfiguration,
	);
	expect(raised).toMatchObject({ maxActiveTurns: 3, state: { kind: "valid" } });
	expect(raised.warnings).toContain(
		"Ignoring project max_active_turns: project cannot raise the user cap",
	);
});

test("reports malformed user configuration without using project authority", async () => {
	const config = await withSettings(
		{ "pi-subagents": { max_active_turns: 9 } },
		{ "pi-subagents": { max_active_turns: 1 } },
		loadSubagentsConfiguration,
	);
	expect(config).toEqual({
		maxActiveTurns: 2,
		state: {
			kind: "invalid",
			reason: "max_active_turns must be an integer between 1 and 8 in user settings",
		},
		warnings: [],
	});
});
