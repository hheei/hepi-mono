import { describe, expect, test } from "bun:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import {
	createDollarSkillAutocompleteProvider,
	type DollarSkillCommand,
	expandDollarSkillReferences,
	extractDollarSkillToken,
	getDollarSkillSuggestions,
} from "../../src/dollar-skill/model.js";

const commands: readonly DollarSkillCommand[] = [
	{
		name: "skill:librarian",
		description: "Research libraries",
		source: "skill",
		sourceInfo: { path: "/user/librarian/SKILL.md", scope: "user", origin: "top-level" },
	},
	{
		name: "deploy-plan",
		description: "Prepare deployment plans",
		source: "skill",
		sourceInfo: { path: "/package/deploy-plan/SKILL.md", origin: "package" },
	},
	{ name: "review", source: "extension", sourceInfo: { path: "/not-a-skill" } },
];

describe("dollar skill model", () => {
	test("extracts only standalone name-like tokens before the cursor", () => {
		expect(extractDollarSkillToken(["Use $lib"], 0, 8)).toEqual({ query: "lib", prefix: "$lib" });
		expect(extractDollarSkillToken(["($deploy-plan"], 0, 13)).toEqual({
			query: "deploy-plan",
			prefix: "$deploy-plan",
		});
		expect(extractDollarSkillToken(["Cost $5"], 0, 7)).toBeUndefined();
		expect(extractDollarSkillToken(["abc$lib"], 0, 7)).toBeUndefined();
	});

	test("filters loaded skill commands and uses canonical provenance", () => {
		expect(getDollarSkillSuggestions(commands, "")).toEqual([
			{
				value: "$deploy-plan",
				label: "deploy-plan",
				description: "Extension - Prepare deployment plans",
			},
			{ value: "$librarian", label: "librarian", description: "User - Research libraries" },
		]);
		expect(getDollarSkillSuggestions(commands, "LIB", 1).map((item) => item.value)).toEqual([
			"$librarian",
		]);
	});

	test("prefers an enabled project skill over a disabled global duplicate", () => {
		const duplicates: readonly DollarSkillCommand[] = [
			{
				name: "skill:review",
				description: "Global review",
				source: "skill",
				sourceInfo: { path: "/user/review/SKILL.md", scope: "user", source: "user" },
			},
			{
				name: "skill:review",
				description: "Project review",
				source: "skill",
				sourceInfo: {
					path: "/project/.pi/skills/review/SKILL.md",
					scope: "project",
					source: "project",
				},
			},
		];
		const enabled = (command: DollarSkillCommand) => command.sourceInfo?.scope === "project";

		expect(getDollarSkillSuggestions(duplicates, "", 20, enabled)).toEqual([
			{
				value: "$review",
				label: "review",
				description: "Project - Project review",
			},
		]);
		expect(expandDollarSkillReferences("Use $review.", duplicates, enabled)).toBe(
			"Use /project/.pi/skills/review/SKILL.md.",
		);
	});

	test("sorts disabled skills last and dims their display text", () => {
		const mixed: readonly DollarSkillCommand[] = [
			{ name: "skill:zeta", description: "Zeta", source: "skill" },
			{ name: "skill:alpha", description: "Alpha", source: "skill" },
			{ name: "skill:beta", description: "Beta", source: "skill" },
		];

		expect(
			getDollarSkillSuggestions(mixed, "", 20, (command) => command.name !== "skill:alpha"),
		).toEqual([
			{ value: "$beta", label: "beta", description: "Skill - Beta" },
			{ value: "$zeta", label: "zeta", description: "Skill - Zeta" },
			{
				value: "$alpha",
				label: "\x1b[2malpha\x1b[22m",
				description: "\x1b[2mSkill - Alpha\x1b[22m",
			},
		]);
	});

	test("expands known references at punctuation boundaries", () => {
		expect(expandDollarSkillReferences("Use $librarian, then $deploy-plan.", commands)).toBe(
			"Use /user/librarian/SKILL.md, then /package/deploy-plan/SKILL.md.",
		);
		expect(
			expandDollarSkillReferences("Keep $unknown, $5 and x$librarian", commands),
		).toBeUndefined();
		expect(expandDollarSkillReferences("Do not expand $skill:librarian", commands)).toBeUndefined();
	});

	test("layers autocomplete and delegates unrelated input", async () => {
		let delegated = 0;
		let delegatedCompletion = 0;
		const current: AutocompleteProvider = {
			triggerCharacters: ["/"],
			async getSuggestions() {
				delegated++;
				return null;
			},
			applyCompletion(_lines, cursorLine) {
				delegatedCompletion++;
				return { lines: ["/plan "], cursorLine, cursorCol: 6 };
			},
			shouldTriggerFileCompletion: () => true,
		};
		const provider = createDollarSkillAutocompleteProvider(
			current,
			() => commands,
			() => ({ enabled: true, maxSuggestions: 20 }),
		);
		const signal = new AbortController().signal;
		expect(provider.triggerCharacters).toEqual(["/", "$"]);
		expect(await provider.getSuggestions(["Use $lib"], 0, 8, { signal })).toEqual({
			prefix: "$lib",
			items: [
				{ value: "$librarian", label: "librarian", description: "User - Research libraries" },
			],
		});
		expect(provider.shouldTriggerFileCompletion?.(["Use $lib"], 0, 8)).toBe(false);
		expect(
			provider.applyCompletion(
				["Use $lib now"],
				0,
				8,
				{ value: "$librarian", label: "librarian" },
				"$lib",
			),
		).toEqual({ lines: ["Use $librarian now"], cursorLine: 0, cursorCol: 14 });
		expect(
			provider.applyCompletion(
				["Use $lib,"],
				0,
				8,
				{ value: "$librarian", label: "librarian" },
				"$lib",
			),
		).toEqual({ lines: ["Use $librarian,"], cursorLine: 0, cursorCol: 14 });
		expect(await provider.getSuggestions(["Use file"], 0, 8, { signal })).toBeNull();
		expect(
			provider.applyCompletion(["/pl"], 0, 3, { value: "plan", label: "plan" }, "/pl"),
		).toEqual({ lines: ["/plan "], cursorLine: 0, cursorCol: 6 });
		expect(delegated).toBe(1);
		expect(delegatedCompletion).toBe(1);
	});

	test("delegates autocomplete and file completion when disabled", async () => {
		let suggestions = 0;
		const current: AutocompleteProvider = {
			async getSuggestions() {
				suggestions++;
				return null;
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
			shouldTriggerFileCompletion: () => true,
		};
		const provider = createDollarSkillAutocompleteProvider(
			current,
			() => commands,
			() => ({ enabled: false, maxSuggestions: 1 }),
		);
		const signal = new AbortController().signal;
		expect(await provider.getSuggestions(["$lib"], 0, 4, { signal })).toBeNull();
		expect(provider.shouldTriggerFileCompletion?.(["$lib"], 0, 4)).toBe(true);
		expect(suggestions).toBe(1);
	});
});
