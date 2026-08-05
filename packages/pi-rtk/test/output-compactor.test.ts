import { describe, expect, test } from "bun:test";
import { compactToolResult } from "../src/rtk/output-compactor.js";
import { DEFAULT_RTK_INTEGRATION_CONFIG } from "../src/rtk/types.js";

describe("RTK output compactor", () => {
	test("preserves project skill reads relative to the session cwd", () => {
		const content = Array.from({ length: 81 }, (_, index) => `${index + 1}: instruction`).join(
			"\n",
		);
		const config = {
			...DEFAULT_RTK_INTEGRATION_CONFIG,
			outputCompaction: {
				...DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction,
				preserveExactSkillReads: true,
				readCompaction: { enabled: true },
				truncate: { enabled: true, maxChars: 1 },
			},
		};

		const outcome = compactToolResult(
			{
				toolName: "read",
				input: { path: "/tmp/session/.pi/skills/review/SKILL.md" },
				content: [{ type: "text", text: content }],
			},
			config,
			undefined,
			{ cwd: "/tmp/session" },
		);

		expect(outcome).toEqual({ changed: false, techniques: [] });
	});
});
