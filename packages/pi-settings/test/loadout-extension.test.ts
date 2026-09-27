import type { ExtensionAPI, ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";
import { setDisabledSkillKeys } from "@hheei/pi-ext-core";
import { expect, test } from "vitest";
import { filterEnabledSkills, default as piSettingsExtension } from "../src/extension.js";

type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;

function skill(name: string): Skill {
	return {
		name,
		description: `${name} skill.`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: {
			path: `/skills/${name}/SKILL.md`,
			source: "skills",
			scope: "user",
			origin: "package",
		},
		disableModelInvocation: false,
	};
}

test("keeps only the skills Loadout still enables", () => {
	const pi = { events: {} } as unknown as ExtensionAPI;
	setDisabledSkillKeys(pi, ["disabled"]);
	const enabled = filterEnabledSkills(pi, [skill("enabled"), skill("disabled")]);
	expect(enabled.map((entry) => entry.name)).toEqual(["enabled"]);
	// Nothing disabled: the list is passed through unchanged.
	expect(filterEnabledSkills(pi, [skill("enabled")])).toHaveLength(1);
});

test("registers /ext-settings only and rejects unavailable command contexts", async () => {
	const commands = new Map<string, CommandHandler>();
	const pi = {
		events: {},
		on: () => undefined,
		registerCommand: (commandName: string, definition: { readonly handler: CommandHandler }) => {
			commands.set(commandName, definition.handler);
		},
	} as unknown as ExtensionAPI;
	piSettingsExtension(pi);
	// Loadout is reached as a page id (`/ext-settings loadout`), not as a second command.
	expect([...commands.keys()]).toEqual(["ext-settings"]);
	const settings = commands.get("ext-settings");
	expect(settings).toBeDefined();

	const notices: Array<{ readonly message: string; readonly level?: string }> = [];
	const notify = (message: string, level?: string): void => {
		notices.push(level === undefined ? { message } : { message, level });
	};
	await settings?.("loadout", {
		mode: "print",
		ui: { notify },
	} as unknown as ExtensionCommandContext);
	await settings?.("loadout", {
		mode: "tui",
		ui: { notify },
	} as unknown as ExtensionCommandContext);
	await settings?.("", { mode: "tui", ui: { notify } } as unknown as ExtensionCommandContext);
	expect(notices).toEqual([
		{ message: "/ext-settings requires TUI mode.", level: "warning" },
		{ message: "Settings are not active for this session.", level: "warning" },
		{ message: "Settings are not active for this session.", level: "warning" },
	]);
});
