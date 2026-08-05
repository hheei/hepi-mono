import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRetainReceipt,
  listRetainReceipts,
} from "../extensions/lifecycle/retain-receipts.js";

describe("retain receipts", () => {
  it("redacts and truncates explicit retain receipt context before local persistence", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-receipts-"));
    const secret = "HINDSIGHT_API_KEY=sk-abcdefghijklmnopqrstuvwxyz";

    await appendRetainReceipt(
      cwd,
      {
        bankId: "project-bank",
        documentId: "doc",
        queueJobId: "job",
        updateMode: "replace",
        source: "tool",
        context: `${secret} ${"x".repeat(50)}`,
        tags: ["source:pi"],
      },
      { redactSecrets: true, maxContextChars: 40 },
    );

    const [receipt] = await listRetainReceipts(cwd);
    expect(receipt?.context).toContain("HINDSIGHT_API_KEY=[REDACTED]");
    expect(receipt?.context).toContain("…[truncated]");
    expect(receipt?.context).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });
});
