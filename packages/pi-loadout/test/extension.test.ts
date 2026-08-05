import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	filterDisabledSkillsFromSystemPrompt,
	default as piLoadoutExtension,
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

test("registers /loadout and rejects unavailable command contexts", async () => {
	let name: string | undefined;
	let handler: CommandHandler | undefined;
	const pi = {
		events: {},
		on: () => undefined,
		registerCommand: (commandName: string, definition: { readonly handler: CommandHandler }) => {
			name = commandName;
			handler = definition.handler;
		},
	} as unknown as ExtensionAPI;
	piLoadoutExtension(pi);
	expect(name).toBe("loadout");
	expect(handler).toBeDefined();

	const notices: Array<{ readonly message: string; readonly level?: string }> = [];
	const notify = (message: string, level?: string): void => {
		notices.push(level === undefined ? { message } : { message, level });
	};
	await handler?.("", { mode: "print", ui: { notify } } as unknown as ExtensionCommandContext);
	await handler?.("", { mode: "tui", ui: { notify } } as unknown as ExtensionCommandContext);
	expect(notices).toEqual([
		{ message: "/loadout requires TUI mode.", level: "warning" },
		{ message: "Loadout is not active for this session.", level: "warning" },
	]);
});
