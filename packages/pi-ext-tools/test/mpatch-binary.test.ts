import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	BUNDLED_MPATCH_SOURCES,
	BUNDLED_MPATCH_VERSION,
	getBundledMpatchPath,
} from "../src/apply-patch/mpatch-binary.js";

const supportedTargets = [
	["darwin", "arm64"],
	["darwin", "x64"],
	["linux", "arm64"],
	["linux", "x64"],
	["win32", "arm64"],
	["win32", "x64"],
] as const;

describe("bundled mpatch runtime", () => {
	test("pins one release for six supported platforms", (): void => {
		expect(BUNDLED_MPATCH_VERSION).toBe("1.6.4");
		expect(BUNDLED_MPATCH_SOURCES.map((source) => source.target)).toEqual(
			supportedTargets.map(([platform, arch]) => `${platform}-${arch}`),
		);
		for (const source of BUNDLED_MPATCH_SOURCES) {
			expect(source.archiveUrl).toContain(`/v${BUNDLED_MPATCH_VERSION}/`);
			expect(source.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
		}
	});

	test("selects an existing package-owned executable for every target", (): void => {
		for (const [platform, arch] of supportedTargets) {
			const path = getBundledMpatchPath(platform, arch);
			expect(existsSync(path)).toBe(true);
			expect(path).toContain(`bin/mpatch/${platform}-${arch}/mpatch`);
		}
	});

	test("rejects an unsupported target instead of probing PATH", (): void => {
		expect(() => getBundledMpatchPath("freebsd", "x64")).toThrow(
			"Bundled mpatch 1.6.4 does not support freebsd-x64",
		);
	});
});
