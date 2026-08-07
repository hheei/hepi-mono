import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PI_HINDSIGHT_USER_AGENT, PI_HINDSIGHT_VERSION } from "../extensions/version.js";

function isVersionMetadata(value: unknown): value is { version: string } {
	return (
		typeof value === "object" && value !== null && typeof Reflect.get(value, "version") === "string"
	);
}

function readPackageVersion(): string {
	const parsed: unknown = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);
	if (!isVersionMetadata(parsed)) {
		throw new Error("package.json version is missing");
	}
	return parsed.version;
}

describe("runtime version metadata", () => {
	it("keeps user-agent version aligned with package.json", () => {
		const version = readPackageVersion();
		expect(PI_HINDSIGHT_VERSION).toBe(version);
		expect(PI_HINDSIGHT_USER_AGENT).toBe(`pi-hindsight/${version}`);
	});
});
