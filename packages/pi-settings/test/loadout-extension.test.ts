import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import {
	filterDisabledSkillsFromSystemPrompt,
	default as piSettingsExtension,
} from "../src/extension.js";

type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;

const SKILLS_PROMPT = `Before

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>enabled</name>
    <description>Enabled skill.</description>
    <location>/skills/enabled/SKILL.md</location>
  </skill>
  <skill>
    <name>disabled</name>
    <description>Disabled skill.</description>
    <location>/skills/disabled/SKILL.md</location>
  </skill>
</available_skills>
After`;

test("removes Loadout-disabled skills from Pi's available-skills prompt section", () => {
	const filtered = filterDisabledSkillsFromSystemPrompt(SKILLS_PROMPT, new Set(["skill:disabled"]));
	expect(filtered).toContain("<name>enabled</name>");
	expect(filtered).not.toContain("<name>disabled</name>");
	expect(filtered).toContain("After");
});

test("removes an empty available-skills prompt section", () => {
	const filtered = filterDisabledSkillsFromSystemPrompt(
		SKILLS_PROMPT,
		new Set(["skill:enabled", "skill:disabled"]),
	);
	expect(filtered).not.toContain("<available_skills>");
	expect(filtered).toBe("Before\nAfter");
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
