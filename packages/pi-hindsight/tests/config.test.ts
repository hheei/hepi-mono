import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../extensions/config/config.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-hindsight-"));
}

function writeSettings(cwd: string, config: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-hindsight": config }));
}

describe("settings.json config resolution", () => {
  it("reads only the pi-hindsight project section", () => {
    const cwd = tmp();
    writeSettings(cwd, { recall: { maxTokens: 123 }, banks: { project: { bankId: "bank" } } });

    const config = resolveConfig(cwd, {});

    expect(config.recall.maxTokens).toBe(123);
    expect(config.banks.project.bankId).toBe("bank");
  });

  it("ignores the removed hindsight.json file", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "hindsight.json"), JSON.stringify({ recall: { maxTokens: 123 } }));

    expect(resolveConfig(cwd, {}).recall.maxTokens).toBe(800);
  });

  it("merges user settings before project settings", () => {
    const cwd = tmp();
    const home = tmp();
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ "pi-hindsight": { recall: { budget: "low", maxTokens: 300 } } }),
    );
    writeSettings(cwd, { recall: { maxTokens: 700 } });

    const config = resolveConfig(cwd, { HOME: home });

    expect(config.recall.budget).toBe("low");
    expect(config.recall.maxTokens).toBe(700);
  });

  it("applies environment overrides after settings", () => {
    const cwd = tmp();
    writeSettings(cwd, { enabled: false, hindsight: { baseUrl: "http://stored" } });

    const config = resolveConfig(cwd, { PI_HINDSIGHT_ENABLED: "true", HINDSIGHT_BASE_URL: "http://env" });

    expect(config.enabled).toBe(true);
    expect(config.hindsight.baseUrl).toBe("http://env");
  });
});
