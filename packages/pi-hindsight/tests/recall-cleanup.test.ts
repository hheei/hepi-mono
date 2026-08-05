import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  pruneTranscriptRecallBlocks,
  scanTranscriptForRecallBlocks,
} from "../extensions/lifecycle/recall-cleanup.js";

describe("recall cleanup", () => {
  it("scans transcript lines for persisted recall blocks", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "pi-hindsight-recall-cleanup-")), "session.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "<hindsight-memory>leaked</hindsight-memory>" },
        }),
      ].join("\n"),
    );

    const result = await scanTranscriptForRecallBlocks(path);

    expect(result).toMatchObject({ sessionFile: path, lineCount: 2, matchingLines: [2] });
  });

  it("does not match ordinary mentions of recall markup", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "pi-hindsight-recall-cleanup-")), "session.jsonl");
    writeFileSync(
      path,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Please explain <hindsight-memory> tags" },
      }),
    );

    const result = await scanTranscriptForRecallBlocks(path);

    expect(result.matchingLines).toEqual([]);
  });

  it("prunes persisted recall block lines with backup", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "pi-hindsight-recall-cleanup-")), "session.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "<hindsight-memory>leaked</hindsight-memory>" },
        }),
      ].join("\n") + "\n",
    );

    const result = await pruneTranscriptRecallBlocks(path);

    expect(result.pruned).toBe(1);
    expect(result.backupPath).toMatch(/\.hindsight-recall-prune\.\d+\.bak$/);
    expect(readFileSync(result.backupPath, "utf8")).toContain("hindsight-memory");
    const pruned = readFileSync(path, "utf8");
    expect(pruned).toContain("hello");
    expect(pruned).not.toContain("hindsight-memory");
  });
});
