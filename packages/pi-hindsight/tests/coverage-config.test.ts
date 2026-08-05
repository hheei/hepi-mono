import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import vitestConfig from "../vitest.config.js";

type CoverageConfig = {
  include?: string[];
  thresholds?: Record<string, unknown>;
};

const coverage = (vitestConfig as { test?: { coverage?: CoverageConfig } }).test?.coverage ?? {};

// Single-level glob/exact-path matcher (portable across the supported Node range,
// unlike fs.globSync which is Node 22+). All coverage patterns are single-level.
function matchesExistingFile(pattern: string): boolean {
  const base = basename(pattern);
  if (!base.includes("*")) return existsSync(pattern);
  const dir = dirname(pattern);
  if (!existsSync(dir)) return false;
  const regex = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return readdirSync(dir).some((entry) => regex.test(entry));
}

describe("coverage config paths", () => {
  const includePaths = coverage.include ?? [];
  const thresholdPaths = Object.keys(coverage.thresholds ?? {}).filter((key) => key.includes("/"));

  it("includes coverage targets", () => {
    expect(includePaths.length).toBeGreaterThan(0);
  });

  it.each([...includePaths, ...thresholdPaths])(
    "coverage path %s resolves to an existing file",
    (pattern) => {
      expect(matchesExistingFile(pattern)).toBe(true);
    },
  );
});
