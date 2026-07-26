import { describe, expect, test } from "bun:test";
import { shouldSkipUnsupportedFindRewrite } from "../../src/rtk/rtk/find-rewrite-compat.js";

describe("RTK find rewrite compatibility", () => {
	test("keeps compound predicates on native find", () => {
		expect(
			shouldSkipUnsupportedFindRewrite(
				"find docs -type d -empty -print",
				"rtk find docs -type d -empty -print",
			),
		).toBe(true);
		expect(
			shouldSkipUnsupportedFindRewrite(
				"find . -name '*.ts' -not -path '*/node_modules/*'",
				"rtk find . -name '*.ts' -not -path '*/node_modules/*'",
			),
		).toBe(true);
		expect(
			shouldSkipUnsupportedFindRewrite(
				"find . -name '*.tmp' -exec rm {} \\;",
				"rtk find . -name '*.tmp' -exec rm {} \\;",
			),
		).toBe(true);
	});

	test("handles env assignments, command, and pipelines", () => {
		expect(
			shouldSkipUnsupportedFindRewrite(
				"FOO=bar command find docs -empty | head -20",
				"FOO=bar rtk find docs -empty | head -20",
			),
		).toBe(true);
	});

	test("keeps supported find rewrites", () => {
		expect(
			shouldSkipUnsupportedFindRewrite(
				"find docs -type f -name '*.md' -maxdepth 2",
				"rtk find docs -type f -name '*.md' -maxdepth 2",
			),
		).toBe(false);
	});

	test("does not inspect quoted descriptions or unrelated commands", () => {
		expect(
			shouldSkipUnsupportedFindRewrite(
				"printf '%s\\n' 'find -empty'",
				"rtk printf '%s\\n' 'find -empty'",
			),
		).toBe(false);
		expect(shouldSkipUnsupportedFindRewrite("echo find -empty", "rtk echo find -empty")).toBe(
			false,
		);
	});

	test("does not affect rewrites for other RTK commands", () => {
		expect(
			shouldSkipUnsupportedFindRewrite("grep 'find -empty' docs", "rtk grep 'find -empty' docs"),
		).toBe(false);
	});
});
