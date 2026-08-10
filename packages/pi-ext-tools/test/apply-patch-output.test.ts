import { describe, expect, test } from "bun:test";
import { modifiesOutputPath } from "../src/apply-patch-tool.js";

describe("apply_patch output targets", () => {
	test("allows output URLs in file content but rejects output target paths", (): void => {
		const outputUrl = "output:" + "//1";
		expect(
			modifiesOutputPath(
				`*** Begin Patch\n*** Update File: docs/example.md\n@@\n-old\n+${outputUrl}\n*** End Patch`,
			),
		).toBe(false);
		expect(
			modifiesOutputPath(`*** Begin Patch\n*** Delete File: ${outputUrl}\n*** End Patch`),
		).toBe(true);
	});
});
