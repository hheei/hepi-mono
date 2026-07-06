import { test } from "bun:test";
import assert from "node:assert/strict";
import { createSkillPickerEditor } from "../src/index.js";
import { commands, FakeEditor, noopTheme } from "./helpers.js";

const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const defaultDollarSettings = {
	pickerEnabled: true,
	maxSuggestions: 30,
	expandReferences: true,
	highlightReferences: true,
	respectLoadout: true,
};

function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE_PATTERN, "");
}
type TestEditor = FakeEditor & ReturnType<typeof createSkillPickerEditor> & Record<symbol, unknown>;

function createEditor(
	keybindings?: { matches?: (data: string, action: string) => boolean },
	getActiveSkillNames?: () => Set<string>,
): TestEditor {
	return createSkillPickerEditor(
		new FakeEditor(),
		() => commands,
		noopTheme(),
		{ requestRender() {} },
		keybindings,
		() => defaultDollarSettings,
		getActiveSkillNames,
	) as TestEditor;
}

const editor = createEditor();
editor.handleInput("$");
let rendered = stripAnsi(editor.render(96).join("\n"));
assert.match(rendered, /deploy-plan\s+Extension\s+Prepare deployment plans/);
assert.match(rendered, /librarian\s+User\s+Research open-source/);
assert.match(rendered, /pi-subagents\s+Extension\s+Delegate work to subagents/);

const loadoutEditor = createSkillPickerEditor(
	new FakeEditor(),
	() => commands,
	{ selectList: { description: (text: string) => `<muted>${text}</muted>` } },
	{ requestRender() {} },
	undefined,
	() => defaultDollarSettings,
	() => new Set(["pi-subagents"]),
);
loadoutEditor.handleInput("$");
const loadoutRendered = loadoutEditor.render(120).join("\n");
assert.match(loadoutRendered, /pi-subagents\s+Extension\s+Delegate work to subagents/);
assert.match(
	loadoutRendered,
	/<muted>\s+deploy-plan\s+Extension\s+Prepare deployment plans<\/muted>/,
);
assert.ok(loadoutRendered.indexOf("pi-subagents") < loadoutRendered.indexOf("deploy-plan"));

editor.handleInput("l");
rendered = stripAnsi(editor.render(96).join("\n"));
assert.match(rendered, /librarian\s+User\s+Research open-source/);
assert.doesNotMatch(rendered, /deploy-plan\s+Extension/);
assert.doesNotMatch(rendered, /pi-subagents\s+Extension/);

editor.handleInput("\r");
assert.equal(editor.text, "$librarian ");

const backspaceEditor = createEditor();
backspaceEditor.handleInput("$");
const linesWithPicker = backspaceEditor.render(96).length;
assert.ok(linesWithPicker > 1);
backspaceEditor.handleInput("\x7f");
assert.equal(backspaceEditor.text, "");
assert.equal(backspaceEditor.render(96).length, 1);

const navigationEditor = createEditor();
navigationEditor.handleInput("$");
navigationEditor.handleInput("\x1b[B");
navigationEditor.handleInput("\r");
assert.equal(navigationEditor.text, "$librarian ");

const keybindingEditor = createEditor({
	matches(data: string, action: string) {
		return data === `<${action}>`;
	},
});
keybindingEditor.handleInput("$");
keybindingEditor.handleInput("<tui.select.down>");
keybindingEditor.handleInput("<tui.select.confirm>");
assert.equal(keybindingEditor.text, "$librarian ");
const wrappedSymbol = Symbol.for("pi-codex-dollar.highlightWrapped");
const versionSymbol = Symbol.for("pi-codex-dollar.highlightWrappedVersion");
const baseEditorSymbol = Symbol.for("pi-codex-dollar.highlightBaseEditor");
const staleEditor = new FakeEditor();
staleEditor[wrappedSymbol] = true;
const rewrappedEditor = createSkillPickerEditor(staleEditor, () => commands, noopTheme(), {
	requestRender() {},
}) as ReturnType<typeof createSkillPickerEditor> & Record<symbol, unknown>;
assert.notEqual(rewrappedEditor, staleEditor);
assert.equal(rewrappedEditor[wrappedSymbol], true);
assert.equal(typeof rewrappedEditor[versionSymbol], "string");
assert.equal(rewrappedEditor[baseEditorSymbol], staleEditor);
assert.equal(
	createSkillPickerEditor(rewrappedEditor, () => commands, noopTheme(), { requestRender() {} }),
	rewrappedEditor,
);

const preservedBaseEditor = new FakeEditor();
const staleWrappedEditor = new Proxy(preservedBaseEditor, {
	get(target, prop, receiver) {
		if (prop === wrappedSymbol) return true;
		if (prop === baseEditorSymbol) return preservedBaseEditor;
		return Reflect.get(target, prop, receiver);
	},
});
const refreshedWrappedEditor = createSkillPickerEditor(
	staleWrappedEditor,
	() => commands,
	noopTheme(),
	{ requestRender() {} },
) as ReturnType<typeof createSkillPickerEditor> & Record<symbol, unknown>;
assert.notEqual(refreshedWrappedEditor, staleWrappedEditor);
assert.equal(refreshedWrappedEditor[baseEditorSymbol], preservedBaseEditor);
const scrollingCommands = Array.from({ length: 12 }, (_value, index) => ({
	name: `skill:item-${String(index).padStart(2, "0")}`,
	description: `Description ${index}`,
	source: "skill",
	sourceInfo: { path: `/tmp/item-${index}/SKILL.md`, scope: "user" },
}));
const scrollingEditor = createSkillPickerEditor(
	new FakeEditor(),
	() => scrollingCommands,
	noopTheme(),
	{ rows: 10, requestRender() {} },
);
scrollingEditor.handleInput("$");
for (let i = 0; i < 8; i += 1) scrollingEditor.handleInput("\x1b[B");
const scrollingLines = scrollingEditor.render(100).map(stripAnsi);
assert.ok(scrollingLines.length <= 4);
assert.match(scrollingLines.join("\n"), /→ item-08\s+User\s+Description 8/);
assert.doesNotMatch(scrollingLines.join("\n"), /item-00/);

console.log("editor picker ok");

test("editor picker", () => {});
