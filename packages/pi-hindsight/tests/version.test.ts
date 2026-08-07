import { describe, expect, it } from "vitest";
import { PI_HINDSIGHT_USER_AGENT, PI_HINDSIGHT_VERSION } from "../extensions/version.js";
import packageJson from "../package.json" with { type: "json" };

describe("runtime version metadata", () => {
	it("keeps user-agent version aligned with package.json", () => {
		expect(PI_HINDSIGHT_VERSION).toBe(packageJson.version);
		expect(PI_HINDSIGHT_USER_AGENT).toBe(`pi-hindsight/${packageJson.version}`);
	});
});
