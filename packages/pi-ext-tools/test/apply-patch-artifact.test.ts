import { describe, expect, test } from "bun:test";
import { modifiesArtifactPath } from "../src/apply-patch-tool.js";

describe("apply_patch artifact targets", () => {
	test("allows artifact URLs in file content but rejects artifact target paths", (): void => {
		const artifactUrl = "artifact:" + "//1";
		expect(
			modifiesArtifactPath(
				`*** Begin Patch\n*** Update File: docs/example.md\n@@\n-old\n+${artifactUrl}\n*** End Patch`,
			),
		).toBe(false);
		expect(
			modifiesArtifactPath(`*** Begin Patch\n*** Delete File: ${artifactUrl}\n*** End Patch`),
		).toBe(true);
	});
});
