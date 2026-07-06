import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandDollarSkillReferences, highlightDollarSkillReferences } from "../src/index.js";
import { commands } from "./helpers.js";

assert.equal(
	expandDollarSkillReferences(
		"Compare $librarian and $pi-subagents. Keep $UNKNOWN as text.",
		commands,
	),
	"Compare /Users/me/.pi/agent/skills/librarian/SKILL.md and /Users/me/.pi/agent/npm/node_modules/pi-subagents/skills/pi-subagents/SKILL.md. Keep $UNKNOWN as text.",
);

assert.equal(expandDollarSkillReferences("No skill refs here", commands), null);
assert.equal(expandDollarSkillReferences("Use $skill:librarian", commands), null);
assert.equal(expandDollarSkillReferences("Cost $5 stays", commands), null);

assert.equal(
	highlightDollarSkillReferences("Use $librarian and $UNKNOWN", commands),
	"Use $librarian and $UNKNOWN",
);
assert.equal(
	highlightDollarSkillReferences("Use $librarian", commands, {
		fg: (name, text) => `<${name}>${text}</${name}>`,
	}),
	"Use <codexDollarHighlight>$librarian</codexDollarHighlight>",
);
assert.equal(
	highlightDollarSkillReferences("Use $librarian", commands, {
		selectList: { selectedText: (text) => `<selected>${text}</selected>` },
	}),
	"Use <selected>$librarian</selected>",
);

assert.equal(
	highlightDollarSkillReferences("Use $skill:librarian", commands),
	"Use $skill:librarian",
);
assert.equal(highlightDollarSkillReferences("Cost $5 stays", commands), "Cost $5 stays");
const previousNpmRoots = process.env.PI_CODEX_DOLLAR_NPM_ROOTS;
const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-codex-dollar-"));
const fallbackSkillPath = join(
	fixtureRoot,
	"sample-package",
	"skills",
	"packaged-only",
	"SKILL.md",
);
const secondFallbackSkillPath = join(
	fixtureRoot,
	"sample-package",
	"skills",
	"second-packaged",
	"SKILL.md",
);
try {
	mkdirSync(join(fixtureRoot, "sample-package", "skills", "packaged-only"), { recursive: true });
	mkdirSync(join(fixtureRoot, "sample-package", "skills", "second-packaged"), { recursive: true });
	writeFileSync(fallbackSkillPath, "# packaged-only\n");
	writeFileSync(secondFallbackSkillPath, "# second-packaged\n");
	process.env.PI_CODEX_DOLLAR_NPM_ROOTS = fixtureRoot;

	const pathlessPackageCommands = [
		{
			name: "skill:packaged-only",
			description: "Package installed skill",
			source: "skill",
			sourceInfo: {},
		},
		{
			name: "skill:second-packaged",
			description: "Second package installed skill",
			source: "skill",
			sourceInfo: {},
		},
	];

	assert.equal(
		expandDollarSkillReferences("Use $packaged-only", pathlessPackageCommands),
		`Use ${fallbackSkillPath}`,
	);
	assert.equal(
		expandDollarSkillReferences("Use $second-packaged", pathlessPackageCommands),
		`Use ${secondFallbackSkillPath}`,
	);
	assert.equal(
		highlightDollarSkillReferences("Use $packaged-only", pathlessPackageCommands),
		"Use $packaged-only",
	);
} finally {
	if (previousNpmRoots === undefined) {
		delete process.env.PI_CODEX_DOLLAR_NPM_ROOTS;
	} else {
		process.env.PI_CODEX_DOLLAR_NPM_ROOTS = previousNpmRoots;
	}
	rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log("expansion/highlight ok");

test("expansion and highlight", () => {});
