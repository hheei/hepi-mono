import { test } from "bun:test";
import assert from "node:assert/strict";
import { getSkillSuggestions, renderSkillPickerLines } from "../src/index.js";
import { commands, noopTheme } from "./helpers.js";

const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE_PATTERN, "");
}
const librarian = getSkillSuggestions(commands, "lib")[0]!;
const lines = renderSkillPickerLines([librarian], 0, 58, noopTheme());

assert.ok(lines.length > 1);
assert.match(stripAnsi(lines[0]!), /^→ librarian\s+User\s+Research open-source/);
assert.ok(lines[0]!.startsWith("→ librarian"));
assert.match(stripAnsi(lines[1]!), /^\s{8,}/);
assert.match(lines.join(" "), /evidence-backed answers/);

const all = getSkillSuggestions(commands, "");
const multi = renderSkillPickerLines(all, 1, 96, noopTheme());
assert.match(stripAnsi(multi.join("\n")), /deploy-plan\s+Extension\s+Prepare deployment plans/);
assert.match(stripAnsi(multi.join("\n")), /→ librarian\s+User\s+Research open-source/);
assert.match(stripAnsi(multi.join("\n")), /pi-subagents\s+Extension\s+Delegate work to subagents/);
const many = Array.from({ length: 10 }, (_value, index) => ({
	value: `$skill-${index}`,
	label: `skill-${index}`,
	description: `(User) - desc ${index}`,
}));
const scrolled = renderSkillPickerLines(many, 8, 80, noopTheme(), 3);
assert.equal(scrolled.length, 3);
assert.match(stripAnsi(scrolled.join("\n")), /→ skill-8\s+User\s+desc 8/);
assert.doesNotMatch(scrolled.join("\n"), /skill-0/);

const themed = renderSkillPickerLines(
	[{ value: "$colorful", label: "colorful", description: "(User) - plain description" }],
	0,
	80,
	{
		selectList: {
			selectedText: (text: string) => `<selected>${text}</selected>`,
			description: (text: string) => `<description>${text}</description>`,
			scrollInfo: (text: string) => `<scroll>${text}</scroll>`,
		},
	},
	3,
).join("\n");
assert.match(themed, /<selected>→ colorful\s+User\s+plain description<\/selected>/);
assert.doesNotMatch(themed, /<description>plain description<\/description>/);

const unselectedThemed = renderSkillPickerLines(
	[
		{ value: "$a", label: "a", description: "(User) - first" },
		{ value: "$b", label: "b", description: "(User) - second" },
	],
	1,
	80,
	{
		selectList: {
			selectedText: (text: string) => `<selected>${text}</selected>`,
			description: (text: string) => `<description>${text}</description>`,
			scrollInfo: (text: string) => `<scroll>${text}</scroll>`,
		},
	},
	3,
).join("\n");
assert.match(unselectedThemed, /<description>first<\/description>/);
assert.match(unselectedThemed, /<selected>→ b\s+User\s+second<\/selected>/);

console.log("rendering ok");

test("rendering", () => {});
