import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSkillSuggestions } from "../src/index.js";
import { commands } from "./helpers.js";

assert.deepEqual(
	getSkillSuggestions(commands, "").map((item) => item.value),
	["$deploy-plan", "$librarian", "$pi-subagents"],
);

assert.deepEqual(
	getSkillSuggestions(commands, "l").map((item) => item.value),
	["$librarian"],
);

assert.deepEqual(
	getSkillSuggestions(commands, "pi").map((item) => item.value),
	["$pi-subagents"],
);

assert.deepEqual(getSkillSuggestions(commands, "search"), []);

const librarian = getSkillSuggestions(commands, "lib")[0]!;
assert.equal(librarian.value, "$librarian");
assert.equal(librarian.label, "librarian");
assert.equal(
	librarian.description,
	"(User) - Research open-source libraries with evidence-backed answers and GitHub permalinks.",
);
assert.doesNotMatch(librarian.description, /SKILL\.md/);

const project = getSkillSuggestions(commands, "pi")[0]!;
assert.equal(project.description, "(Extension) - Delegate work to subagents");

const extension = getSkillSuggestions(commands, "deploy")[0]!;
assert.equal(extension.description, "(Extension) - Prepare deployment plans");
const previousNpmRoots = process.env.PI_CODEX_DOLLAR_NPM_ROOTS;
const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-codex-dollar-"));
try {
	mkdirSync(join(fixtureRoot, "sample-package", "skills", "packaged-only"), { recursive: true });
	writeFileSync(
		join(fixtureRoot, "sample-package", "skills", "packaged-only", "SKILL.md"),
		"# packaged-only\n",
	);
	process.env.PI_CODEX_DOLLAR_NPM_ROOTS = fixtureRoot;

	const packaged = getSkillSuggestions(
		[
			...commands,
			{
				name: "skill:packaged-only",
				description: "(User) - Package installed skill",
				source: "skill",
				sourceInfo: {},
			},
		],
		"packaged",
	)[0]!;

	assert.equal(packaged.description, "(Extension) - Package installed skill");
	assert.doesNotMatch(packaged.description, /\(User\)/);
} finally {
	if (previousNpmRoots === undefined) {
		delete process.env.PI_CODEX_DOLLAR_NPM_ROOTS;
	} else {
		process.env.PI_CODEX_DOLLAR_NPM_ROOTS = previousNpmRoots;
	}
	rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log("filtering ok");

test("filtering", () => {});
